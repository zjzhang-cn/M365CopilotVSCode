/**
 * Descarga de ficheros generados por Copilot: objetos que la web guarda en
 * `asyncgw.teams.microsoft.com` y referencia en los mensajes del chat.
 *
 * Por qué vive aquí y no dentro de una extensión: el protocolo lo fijaron los
 * experimentos (2026-10) — asyncgw sólo sirve un objeto a peticiones hechas
 * DENTRO de una página con sesión de Microsoft (cookie + token `ic3` + la pila
 * de red del navegador); todo lo demás (curl, PowerShell, TUI, la barra de
 * direcciones) responde 401/404. Así que la descarga la ejecuta la extensión de
 * navegador en el mundo MAIN de `m365.cloud.microsoft`, y este módulo aporta
 * las piezas puras: qué token vale (`isIc3Token`/`acceptIc3Token`), cómo se
 * marca una URL (`downloadUrl`/`downloadTarget`) y de dónde sale el nombre del
 * fichero. Todo es puro — nada de `window` ni `chrome` — para poder probarlo
 * fuera del navegador.
 */
import type { TokenClaims } from "./profile";
import { decodeJwtPayload, extractClaims } from "./jwt";
import { areClaimsUsable, isValidJwt } from "./capture";

// ------------------------------------------------------------------- el token

/**
 * ¿Es un token de Teams (ic3)? Es la llave que exige asyncgw para servir un
 * objeto. No entra en el perfil de Copilot (no es de Sydney), así que el
 * interceptor lo guarda aparte — pero sin él no hay descarga posible.
 */
export function isIc3Token(token: string): boolean {
  const claims = decodeJwtPayload(token);
  if (!claims) return false;
  const aud = String(claims.aud || "");
  return aud.includes("ic3.teams.office.com");
}

/**
 * Lo que el interceptor guarda del token de Teams: el token, su caducidad y
 * las cabeceras que acompañaban a la petición que lo trajo. Esas cabeceras no
 * son decorativas: la descarga las reproduce para que la petición se parezca
 * a la que la web hace de verdad.
 */
export interface Ic3Record {
  token: string;
  claims?: TokenClaims | null;
  /** Cabecera `ms-ic3-product` de la petición que lo trajo (p. ej. «Copilot»). */
  product?: string;
  /** Cabecera `x-ms-client-version` de esa misma petición. */
  clientVersion?: string;
  capturedAt?: string;
}

/**
 * Lo que hay que guardar si `token` merece sustituir al actual, o null: debe
 * ser un JWT válido, de Teams (ic3), sin caducar, y o bien distinto del
 * guardado (y no más viejo por `exp`), o el mismo token con cabeceras que la
 * primera captura no trajo — el `fetch` del interceptor las ve todas, el hook
 * de `XMLHttpRequest` no, así que la segunda visita al mismo token completa el
 * registro en vez de descartarlo.
 */
export function acceptIc3Token(
  current: Ic3Record | null | undefined,
  token: string,
  extras: { product?: string | null; clientVersion?: string | null } = {},
  now = Date.now(),
): Ic3Record | null {
  const candidate = token.trim();
  if (!isValidJwt(candidate)) return null;
  if (!isIc3Token(candidate)) return null;
  const claims = extractClaims(candidate);
  if (!areClaimsUsable(claims, now)) return null;
  const product = extras.product?.trim() || undefined;
  const clientVersion = extras.clientVersion?.trim() || undefined;

  if (current?.token === candidate) {
    const nextProduct = product ?? current.product;
    const nextClient = clientVersion ?? current.clientVersion;
    if (nextProduct === current.product && nextClient === current.clientVersion) return null;
    return {
      ...current,
      ...(nextProduct ? { product: nextProduct } : {}),
      ...(nextClient ? { clientVersion: nextClient } : {}),
    };
  }

  const currentExp = current?.claims?.exp ?? 0;
  if (claims?.exp && currentExp && claims.exp < currentExp) return null;
  return {
    token: candidate,
    claims,
    ...(product ? { product } : {}),
    ...(clientVersion ? { clientVersion } : {}),
  };
}

/**
 * El registro si su token sigue vivo, o null: caducado ya no sirve para
 * descargar (y guardarlo invitaría a intentos condenados a 401).
 */
export function withoutExpiredIc3(
  record: Ic3Record | null | undefined,
  now = Date.now(),
): Ic3Record | null {
  if (!record?.token) return null;
  const exp = record.claims?.exp;
  if (typeof exp === "number" && exp * 1000 <= now) return null;
  return record;
}

// -------------------------------------------------------------------- la URL

/**
 * Objeto de asyncgw:
 * `https://<nube>.asyncgw.teams.microsoft.com/v1/objects/<id>/views/original[/<nombre>]`.
 *
 * Se valida SIEMPRE antes de usarlo: el marcador de descarga viaja en una URL
 * que cualquiera puede enlazar, y sin esta criba una web ajena podría hacer
 * que la extensión descargase desde otro sitio (y con el token de Teams de la
 * víctima en la mano).
 */
const ASYNCGW_OBJECT_URL =
  /^https:\/\/[a-z0-9-]+\.asyncgw\.teams\.microsoft\.com\/v1\/objects\/[A-Za-z0-9_-]+\/views\/original(?:\/[^?#]*)?$/i;

/** Tope de longitud para una URL de objeto; una legítima no se acerca. */
export const MAX_OBJECT_URL_CHARS = 2048;

/** ¿Es una URL de objeto de asyncgw (y no cualquier otra cosa)? */
export function isAsyncgwObjectUrl(url: unknown): url is string {
  return (
    typeof url === "string" && url.length <= MAX_OBJECT_URL_CHARS && ASYNCGW_OBJECT_URL.test(url)
  );
}

/**
 * Marcador con el que una URL de chat pide la descarga de un objeto:
 * `…/chat/?m365copilot-download=<url del objeto>`. La regla DNR de la
 * extensión de navegador redirige aquí las navegaciones a asyncgw, que es lo
 * que convierte cualquier clic (web, VS Code, TUI, correo…) en una descarga
 * real; también puede usarlo cualquier otro punto de entrada sin inventarse
 * un protocolo nuevo.
 */
export const DOWNLOAD_PARAM = "m365copilot-download";

/** `…/chat/?m365copilot-download=<objeto>` */
export function downloadUrl(chatUrl: string, target: string): string {
  const url = new URL(chatUrl);
  url.searchParams.set(DOWNLOAD_PARAM, target);
  return url.toString();
}

/**
 * El objeto a descargar según el marcador de esta URL, o null. Valida el
 * destino: que una URL lleve el marcador no significa que su contenido sea
 * legítimo.
 */
export function downloadTarget(url: string): string | null {
  try {
    const value = new URL(url).searchParams.get(DOWNLOAD_PARAM)?.trim();
    return isAsyncgwObjectUrl(value) ? value : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- el nombre

/** Caracteres que ningún sistema de ficheros razonable quiere en un nombre. */
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * Nombre con el que guardar el objeto: el último segmento de la URL,
 * decodificado y sin caracteres problemáticos (los objetos de Copilot suelen
 * traerlo, p. ej. `…/快速排序_SVG.zip`). null si la URL no lo trae: quien
 * llama decide el nombre por defecto.
 */
export function filenameFromObjectUrl(target: string): string | null {
  try {
    const { pathname } = new URL(target);
    const marker = "/views/original/";
    const index = pathname.indexOf(marker);
    if (index === -1) return null;
    const encoded = pathname
      .slice(index + marker.length)
      .split("/")
      .pop();
    if (!encoded) return null;
    const cleaned = decodeURIComponent(encoded).replace(UNSAFE_FILENAME_CHARS, "").trim();
    return cleaned || null;
  } catch {
    return null;
  }
}
