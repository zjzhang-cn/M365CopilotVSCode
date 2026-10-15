/**
 * Tests de la lógica de descarga compartida (@m365copilot/core, download.ts):
 * el token de Teams (ic3), la validación de URLs de objeto de asyncgw y el
 * marcador `m365copilot-download`. Es la única vía que existe hacia esos
 * ficheros, así que un fallo aquí deja las descargas en nada.
 *
 * Run: node --experimental-strip-types --import ./test/register.mjs test/download.mts
 */
import assert from "node:assert/strict";
import {
  DOWNLOAD_PARAM,
  MAX_OBJECT_URL_CHARS,
  acceptIc3Token,
  downloadTarget,
  downloadUrl,
  filenameFromObjectUrl,
  isAsyncgwObjectUrl,
  isIc3Token,
  withoutExpiredIc3,
} from "@m365copilot/core";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const b64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const inMinutes = (minutes: number) => Math.floor(NOW / 1000) + minutes * 60;

function jwt(aud: string, claims: Record<string, unknown> = {}): string {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
    aud,
    iat: inMinutes(-1),
    exp: inMinutes(60),
    ...claims,
  })}.sig`;
}

const IC3 = jwt("https://ic3.teams.office.com");
const SYDNEY = jwt("https://substrate.office.com/sydney");
const OBJECT =
  "https://us-prod.asyncgw.teams.microsoft.com/v1/objects/0-wus-d12-e0e73bbadb3726c70453e7b1912fc1f1/views/original";
const OBJECT_NAMED = `${OBJECT}/${encodeURIComponent("快速排序_SVG.zip")}`;
const CHAT = "https://m365.cloud.microsoft/chat/";

function testIc3Token() {
  assert.equal(isIc3Token(IC3), true);
  assert.equal(isIc3Token(SYDNEY), false, "el de Copilot no sirve para asyncgw");
  assert.equal(isIc3Token(jwt("https://graph.microsoft.com")), false);
  assert.equal(isIc3Token("not-a-jwt"), false);
  console.log("  ✓ token de Teams (ic3) reconocido; los demás no");
}

function testAcceptIc3() {
  const accepted = acceptIc3Token(
    null,
    IC3,
    { product: "Copilot", clientVersion: "2.20261014.16.0" },
    NOW,
  );
  assert.equal(accepted?.token, IC3);
  assert.equal(accepted?.product, "Copilot");
  assert.equal(accepted?.clientVersion, "2.20261014.16.0");
  assert.equal(accepted?.claims?.aud, "https://ic3.teams.office.com");

  // Mismo token sin nada nuevo: no se escribe nada (ni se publica).
  assert.equal(
    acceptIc3Token(accepted, IC3, { product: "Copilot", clientVersion: "2.20261014.16.0" }, NOW),
    null,
  );

  // Mismo token, pero ahora aparecen las cabeceras que el XHR no veía.
  const bare = acceptIc3Token(null, IC3, {}, NOW)!;
  const completed = acceptIc3Token(bare, IC3, { product: "Copilot" }, NOW);
  assert.equal(completed?.product, "Copilot");
  assert.equal(completed?.token, IC3);

  // Nada que sustituya al guardado.
  const expired = jwt("https://ic3.teams.office.com", { exp: inMinutes(-1) });
  assert.equal(acceptIc3Token(null, expired, {}, NOW), null, "caducado");
  const older = jwt("https://ic3.teams.office.com", { exp: inMinutes(30) });
  assert.equal(acceptIc3Token(accepted, older, {}, NOW), null, "más viejo que el guardado");
  assert.equal(acceptIc3Token(null, SYDNEY, {}, NOW), null, "no es ic3");
  assert.equal(acceptIc3Token(null, "a.b", {}, NOW), null, "no es un JWT");

  assert.equal(withoutExpiredIc3(accepted, NOW)?.token, IC3);
  assert.equal(
    withoutExpiredIc3({ token: expired, claims: { exp: inMinutes(-1) } }, NOW),
    null,
    "caducado no se conserva",
  );
  assert.equal(withoutExpiredIc3(null, NOW), null);
  console.log("  ✓ alta del token ic3: sólo se escribe si cambia algo de verdad");
}

function testObjectUrl() {
  assert.equal(isAsyncgwObjectUrl(OBJECT), true);
  assert.equal(isAsyncgwObjectUrl(OBJECT_NAMED), true);
  assert.equal(
    isAsyncgwObjectUrl("https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/abc/views/original/"),
    true,
    "otra nube regional",
  );

  assert.equal(
    isAsyncgwObjectUrl("http://us-prod.asyncgw.teams.microsoft.com/v1/objects/a/views/original"),
    false,
    "sin TLS no",
  );
  assert.equal(isAsyncgwObjectUrl("https://evil.example.com/v1/objects/a/views/original"), false);
  assert.equal(
    isAsyncgwObjectUrl("https://asyncgw.teams.microsoft.com.evil.example/v1/objects/a/views/original"),
    false,
    "dominio con sufijo falso",
  );
  assert.equal(
    isAsyncgwObjectUrl(`${OBJECT.replace("/views/original", "/views/thumbnail")}`),
    false,
    "otra vista no",
  );
  assert.equal(isAsyncgwObjectUrl(`${OBJECT}?x=1`), false, "sin query");
  assert.equal(isAsyncgwObjectUrl(`${OBJECT}#frag`), false, "sin fragmento");
  assert.equal(
    isAsyncgwObjectUrl(
      `https://us-prod.asyncgw.teams.microsoft.com/v1/objects/${"a".repeat(MAX_OBJECT_URL_CHARS)}/views/original`,
    ),
    false,
    "demasiado larga",
  );
  assert.equal(isAsyncgwObjectUrl(42), false);
  console.log("  ✓ URL de objeto validada: dominio, TLS, ruta y tamaño");
}

function testDownloadMark() {
  assert.equal(DOWNLOAD_PARAM, "m365copilot-download");
  const marked = downloadUrl(CHAT, OBJECT_NAMED);
  const parsed = new URL(marked);
  assert.equal(parsed.origin + parsed.pathname, "https://m365.cloud.microsoft/chat/");
  assert.equal(parsed.searchParams.get(DOWNLOAD_PARAM), OBJECT_NAMED);
  assert.equal(downloadTarget(marked), OBJECT_NAMED);
  assert.equal(downloadTarget(CHAT), null, "sin marcador");
  assert.equal(downloadTarget(downloadUrl(CHAT, "https://evil.example.com/x")), null, "destino colado");
  assert.equal(downloadTarget("not a url"), null);
  console.log("  ✓ marcador de descarga: ida y vuelta, y el destino siempre se filtra");
}

function testFilename() {
  assert.equal(filenameFromObjectUrl(OBJECT_NAMED), "快速排序_SVG.zip");
  assert.equal(filenameFromObjectUrl(OBJECT), null, "sin nombre en la URL");
  assert.equal(filenameFromObjectUrl(`${OBJECT}/a%2Fb.zip`), "ab.zip", "sin separadores colados");
  assert.equal(filenameFromObjectUrl(`${OBJECT}/report%3A1.pdf`), "report1.pdf", "sin «:»");
  assert.equal(filenameFromObjectUrl(`${OBJECT}/a%00b.zip`), "ab.zip", "sin controles");
  assert.equal(filenameFromObjectUrl(`${OBJECT}/%20%20`), null, "sólo espacios");
  console.log("  ✓ nombre del fichero: decodificado, limpio y con reserva a null");
}

testIc3Token();
testAcceptIc3();
testObjectUrl();
testDownloadMark();
testFilename();
console.log("All tests passed.");
