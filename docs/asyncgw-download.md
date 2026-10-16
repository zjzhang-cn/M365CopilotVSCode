# asyncgw 文件下载：原因与设计记录

> 记录时间：2026-10 · 分支 `feature/asyncgw-download` · 首次提交 `91e11f2`（基于 `feature/tui` 49b3cc2）
>
> 本文回答三个问题：**为什么必须这么做**（原因）、**方案为何这样设计**（决策依据）、**还差什么**（边界与待办）。

## 1. 问题

Copilot 在对话中生成的打包文件（zip/文档等）托管在 Teams 异步网关对象存储上，链接形态：

```
https://<nube>.asyncgw.teams.microsoft.com/v1/objects/<id>/views/original[/<文件名>]
例：https://us-prod.asyncgw.teams.microsoft.com/v1/objects/0-wus-d8-3.../views/original/快速排序_SVG.zip
```

这些链接出现在 TUI 流式文本（`writeAtCursor`）与 `adaptiveCards` 中，但**在任何浏览器页面之外打开一律失败**：

- 直接粘贴到浏览器（未登录/登录都有）→ 404 或 401
- 从 TUI、VS Code、外部程序打开 → 同上
- 用捕获的凭据程序化请求（curl/PowerShell/脚本）→ 401

目标：让**任何入口**（TUI 复制、VS Code 点击、邮件、地址栏）点击链接都能真正拿到文件。

## 2. 决定性实测（2026-10-15）

| # | 访问方式 | 结果 | 解读 |
|---|---|---|---|
| 1 | 匿名访问 | 401（对象存在）/ 404（已清理） | 端点存在；401 ≠ 404 可区分对象状态 |
| 2 | 仅页面 cookie | 401 | cookie 不是认证方式 |
| 3 | Sydney token（外部） | 401（元数据端点同样 401） | asyncgw 不接受 substrate token |
| 4 | 抓包的 ic3 token（外部） | 401 | 光有 token 不够 |
| 5 | curl 原样复刻全套浏览器头（含 UA/Origin/Referer） | 401 | 手工复刻缺了不止"头" |
| 6 | **已登录页面 console 中 fetch（`credentials:"include"` + ic3 Bearer）** | **200 `application/octet-stream`** | **唯一可行路径** |
| 7 | 网页端自身下载（Network 抓包） | 成功 | 页内 `fetch`、`mode: "cors"`、`credentials: "include"` |

实验 6/7 共同确认：**"浏览器页面上下文 + 页面会话 cookie + ic3 Bearer token"三者组合**是 asyncgw 协作的唯一方式。实验 5 证明"复制请求头"无法脱离浏览器环境。

抓包（实验 7）显示网页下载请求的完整头部：

```http
GET /v1/objects/<id>/views/original
authorization: Bearer <ic3 令牌>
ms-cv: <随机 UUID，每请求一个>
ms-ic3-product: Copilot
x-ms-client-version: 2.20261015.7.0    ← 随网页发布更新（前一天为 2.20261014.16.0）
cache-control: no-cache                ← 页面显式设置
pragma: no-cache                       ← 页面显式设置
priority: u=1, i                       ← 页面显式设置（fetch priority）
```

（`mode: cors`、`credentials: include`、Referer 由浏览器默认策略自动带 `https://m365.cloud.microsoft/`；`accept`/`accept-language` 浏览器自动补。两次抓包（10-15、10-16 各一次）交叉确认：`ms-cv` 每请求随机、`x-ms-client-version` 随网页版本推进、`cache-control`/`pragma`/`priority` 为页面显式设置。）

## 3. 原因分析

### 3.1 为什么页面之外一律 401

asyncgw 的认证设计把请求绑定到**浏览器会话上下文**，而不是某个可复制的凭据：

- 它要求 `ic3` token（`aud=https://ic3.teams.office.com`）——这是 Teams 客户端的会话令牌，不在 MSAL 缓存里公开存放（页面 localStorage 扫描找不到，只能从页面发出的请求头上截获）；
- 它同时要求页面会话 cookie（第一方 cookie，script/curl 难以获得"浏览器网络栈层"的自动携带与轮转）；
- 实测把"头"复制到 curl 仍 401，说明认证背后还有**实时会话状态**（cookie 轮转、TLS 指纹、ms-cv 关联等要素至少其一）——具体是哪一项服务端在检查**未知，也无法从外部验证**，但不影响方案：我们不再尝试复刻，而是直接站进页面上下文。

### 3.2 为什么浏览器页面内可行

实验 6 的 fetch 与实验 7 的页内请求环境完全一致：同一 `m365.cloud.microsoft` 源、同一 fetch API、同一 CORS/preflight 规则、cookie 自动携带、ic3 token 作为普通请求头发送。且实验 7 证明**这是页面对 asyncgw 的标准调用方式**（不是特殊通道），扩展的 MAIN-world fetch 与它逐字节同构，因此可行。

### 3.3 两道"时钟"（时效性）

- **ic3 token 寿命 ~87 分钟**（两次抓包实例：`exp - iat` 分别为 5207s 与 5269s）。比 Sydney token（~8h）短得多。token 过期后需要页面重新活动（一次下载/请求）来刷新捕获。
- **对象寿命 ~8 小时**（实测：约 8 小时前的对象返回 404，被服务端清理）。过期对象任何凭据都无法取回。

结论：**捕获 token → 拿到链接 → 下载**要在时间窗内完成；两条时间线相互独立（token 可以反复刷新，对象不能复活）。

### 3.4 诚实记录的未解释项

- curl 复刻与真实请求的差异到底卡在哪一环（TLS 指纹？cookie 轮转时序？ms-cv 关联？）——外部无法定位，不影响方案。
- 实验 6 的 console fetch 提示我们注意：**DevTools console 的请求被浏览器豁免 CSP**，所以它不能用来证明"页面 JS 也能发"——但实验 7（页面自身的 fetch 抓包）补上了这个证明。

## 4. 方案与设计决策

### 4.1 为什么必须是浏览器扩展

- 唯一能**进入页面上下文**（MAIN world）执行 fetch 的角色 → 满足 3.1/3.2 的认证条件；
- 唯一能**改写网络层导航**（declarativeNetRequest）的角色 → 拦住"任何来源的链接点击"，包括 TUI 复制粘贴、VS Code `openExternal`、邮件客户端打开；
- TUI/VS Code 自身**无法**获得上述任一条件（程序化请求已在实验 3/4/5 证明死路）。

### 4.2 为什么用 DNR 重定向 + 标记 URL

导航栏回车、外部程序打开链接都是 `main_frame` 导航——此时**还没有任何页面脚本在跑**（目标就是 asyncgw 域名，content script 的 matches 也不含它）。DNR 静态规则是唯一能在请求发出前介入的机制：

```
asyncgw 对象 URL（main_frame 导航）
  → DNR 重定向（public/rules/asyncgw.json）
  → https://m365.cloud.microsoft/chat/?m365copilot-download=<对象URL>
```

到站后再由页面内的 interceptor 完成下载（见 4.3）。标记 URL 模式**复用项目已有先例** `?m365copilot-signout=<id>`（signOut.ts），不发明新协议；任何入口只要把链接交给浏览器打开，就自动进入这条流水线。

### 4.3 为什么下载在 MAIN world 执行

下载必须满足 3.1 的认证条件，只有 MAIN world 站在页面里。interceptor 在 `document_start` **自检 `location.href` 的标记**（不依赖 content bridge 转发，避免两个脚本注入顺序的不确定性），立即 `replaceState` 清掉标记（刷新不重复下载），等 DOM ready 后：

```
fetch(target, { credentials:"include",
                headers:{ authorization:"Bearer <ic3>",
                          "ms-ic3-product": <捕获值>,
                          "x-ms-client-version": <捕获值> }})
  → blob → a.click() 下载
```

### 4.4 为什么 ic3 token 单独存储、绝不下发

- ic3 token **不是** Sydney token，不满足现有捕获过滤（aud 校验）→ 独立键 `m365copilot.ic3.v1` 存储，避免污染 `m365copilot.capture.v1`（该 profile 会同步给 VS Code/TUI）；
- 它**没有独立使用价值**（实验 4：外部带它也是 401），价值仅在页面上下文中——所以同步出去只会扩大泄露面，零收益。同步链（浏览器 → VS Code/TUI）完全不动。
- 捕获方式：interceptor hook 页面的 `fetch`/`XHR`，从请求头的 `authorization` 中识别 ic3（`aud` 包含 `ic3.teams.office.com`）；同一 token 再次出现时补全 `ms-ic3-product`/`x-ms-client-version` 元数据（XHR hook 看不到头部，fetch hook 能看到，两者互补）。

### 4.5 为什么 TUI / VS Code 零改动

下载执行完全发生在浏览器扩展层，所有入口殊途同归：

```
TUI 复制链接 / VS Code 点击 / 地址栏粘贴 / 邮件
        │  asyncgw URL 的 main_frame 导航
        ▼
DNR 重定向 → chat 页标记 → MAIN world fetch → 文件落地
```

两端无需任何代码感知"下载"这件事的存在。

### 4.6 安全设计

- `downloadTarget`/`isAsyncgwObjectUrl`：标记 URL **任何人都能构造**，所以目标 URL 必须通过域名锚定的白名单正则（且限长 2048）——否则外部网页可借扩展之手把 Teams token 发给任意服务器；
- `replaceState` 抢在 SPA 路由前清除标记，防重复触发；
- 过期 token 在 tick 中主动清除（`withoutExpiredIc3`），避免注定 401 的重试。

## 5. 实现现状（提交 91e11f2）

| 层 | 文件 | 职责 |
|---|---|---|
| 纯逻辑 | `packages/core/src/download.ts` | `isIc3Token`/`acceptIc3Token`/`withoutExpiredIc3`、URL 白名单、`downloadUrl`/`downloadTarget`、`filenameFromObjectUrl` |
| 常量 | `packages/core/src/constants.ts` | `IC3_STORE_KEY`、`ASYNCGW_HOST_PERMISSION` |
| 拦截 | `extensiones/browser/entrypoints/interceptor.content.ts` | ic3 捕获分流 + 标记自检 + MAIN world 下载 |
| 桥接 | `extensiones/browser/entrypoints/content.ts` | 下载结果日志（`DOWNLOAD_RESULT`） |
| 网络层 | `extensiones/browser/public/rules/asyncgw.json` + `wxt.config.base.ts` | DNR 重定向规则（非 Firefox 分支注入 manifest） |
| 测试 | `extensiones/browser/test/download.mts` | 5 组静态测试（token/URL/往返/注入拒绝/文件名） |

验证已过：core build ✓ / browser typecheck ✓ / 全部测试 ✓ / Chrome 构建 manifest 含 DNR ✓ / Firefox 干净降级 ✓。

## 6. 已知边界

| 边界 | 表现 | 原因 |
|---|---|---|
| 需要"激活"捕获 | 从未在网页端活动过 → alert 提示 | ic3 token 只能从页面请求头截获 |
| ic3 token ~87 分钟 | 过期 alert，需网页端再活动一次 | 见 3.3 |
| 对象 ~8 小时清理 | 404，无法挽回 | 服务端生命周期 |
| Firefox 无 DNR | 不自动跳转（需手动走网页下载） | MV2 不支持 declarativeNetRequest |
| CSP（理论风险） | 若被拦：alert `Failed to fetch` + console 明文 violation | MAIN world fetch 受页面 CSP connect-src 约束；实验 7 已证明页面环境允许，风险低 |

## 7. 待办加固（2026-10-16 分析新发现）

对照抓包请求，当前实现还有 4 处可加固（均未实施）：

1. **请求头对齐**：补 `ms-cv`（随机 UUID，一行 `crypto.randomUUID()`）；可选补 `cache-control: no-cache` + `pragma: no-cache`（页面显式设置，兼防中间缓存旧响应）；
2. **文件名优先 `Content-Disposition`**：抓包 URL 形态为 `/views/original`（无文件名）时，现在会 fallback 成 `copilot-file-<时间戳>.bin`；响应头里的真实文件名若被 CORS expose 应优先解析；
3. **redirect/非二进制响应防御**：会话过期时 fetch 可能跟到登录页返回 HTML（200）→ 存成垃圾 .bin。`response.redirected` / content-type 检查后明确报"会话过期"；
4. **时效文案**：alert 说明 ic3 token ~87 分钟寿命，引导"去网页端下载一次再回来"。

## 8. 实机验证清单

1. 重载扩展（`chrome://extensions` → `releases/chrome/chrome-mv3` 重新加载）
2. 打开 `m365.cloud.microsoft/chat/`，**在网页端真实下载一次文件**（激活 ic3 捕获）；
3. 可选排障：`localStorage.setItem('m365copilot.debug','1')` 后刷新，确认日志 `token de Teams (ic3) actualizado`；检查 `localStorage['m365copilot.ic3.v1']` 含 `token`/`product: "Copilot"`；
4. 从 TUI 复制一条**新鲜的** asyncgw 链接 → 地址栏回车（确保 URL 完整、无换行/尾部标点）；
5. 预期：地址栏先见 asyncgw → 立即跳转 chat 页（带 `?m365copilot-download=`）→ 文件开始下载 → console 日志 `Descarga completada`；
6. 失败诊断：alert 文案 + console 日志（含 CSP violation 则为 CSP 问题；`HTTP 401` 为 token 过期需重新激活）。
