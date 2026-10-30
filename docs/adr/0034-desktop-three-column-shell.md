# ADR-0034: 桌面外壳三栏化——左侧栏、右侧上下文栏与 macOS 隐藏标题栏

- 状态：Accepted（**2026-10-29 用户直接提出并拍定取舍；同日落码，浏览器端到端目视核验通过，macOS 真机窗口（隔离 HOME）复核通过**）
- 日期：2026-10-29
- 关联：[ADR-0024](0024-home-workbench-merge-search-page.md)（首页工作台化——本 ADR 不改首页内部叙事，只改它住在哪个壳里）、[ADR-0015](0015-w3-minimal-compile-loop.md)（待审核队列的数据来源）、[ADR-0032](0032-approved-wiki-page-visibility.md)（最近更新的知识页来源）、[ADR-0006](0006-scope-freeze.md)（冻结标识——二进制名 `repotory` 不动，只改 bundle 目录名）、[ADR-0029](0029-in-app-update-download.md)（更新徽标从导航栏迁到左栏，判定与存储仍是同一份）
- 起点 schema：v28（**本 ADR 无 schema 变更**）

## 背景

### 事实一：用户点出的第一条——一级布局不是桌面该有的样子

用户反馈（2026-10-29）：「桌面App目前的布局需要调整……大部分桌面App一级布局都是左中右，最左边可以窄一点并包住关闭放大缩小等按钮」。改动前的外壳是**一条横贯顶部的导航栏**（品牌标记 + 七个顶级入口 + 主题/语言 + 更新徽标）加一条居中的内容列：

- 导航栏把 860px 窗口高度里的约 60px 整条吃掉，换来的信息量只是七个链接——它是一条**网页导航栏**，不是桌面应用的导航；
- 品牌标记占了导航栏左侧一大块，导航入口却压在右侧，视线要横跨整条栏；
- 右侧 300px 以上的屏幕空间始终空着，没有任何一个常驻表面回答「现在有什么在等我」。

### 事实二：macOS 上这个壳是坏的，而且是平台形状的坏

Wails 的 macOS 窗口即便隐藏标题栏也保留 `NSWindowStyleMaskTitled`，交通灯（关闭/最小化/全屏）由系统画在 **webview 内容区左上角**。旧导航栏是全宽的，于是 macOS 构建里导航栏最左端——恰好是品牌标记所在的位置——被压在交通灯底下；Windows/Linux 保留原生标题框，同样的导航栏看着完全正常。

**这个缺陷只在 macOS 上出现，也只在 macOS 上肉眼可见**，因此它一路活到用户亲手打开 app 才被发现。修法不能是「再调一下 padding」，那是在一条本来就该换掉的布局上打补丁。

### 事实三：应用名还是全小写

用户反馈第五条：「目前桌面App的应用名还是全小写的，不符合惯例」。根因在 `wails.json`：`name` 写的是 `repotory`，而 `outputfilename` 也写的是 `repotory`——前者决定 bundle 目录名（`build/bin/repotory.app`）与 DMG 卷名，后者决定 bundle 里的可执行文件名。`productName` 是 `Repotory`，但它管不到这两处，于是产物在 Finder、Launchpad、`/Applications` 里全程以小写出现。

### 事实四：右栏不需要新后端

「什么在等我」这件事，数据早就齐了：待审核队列是 ADR-0015 的闸门产物（`listPendingWikiPages`），最近更新是 ADR-0032 放开的已批准页（`browseWikiPages`，按 `updated_at DESC`）。**右栏不需要新绑定**，只需要把已有的两个查询摆在顺手的位置。

## 决策

**1. 外壳改成三栏：72px 左侧栏 / 中栏内容 / 288px 右侧上下文栏。**

- 左栏（`SideRail`）：品牌标记 + 七个顶级入口（首页/仪表盘/搜索/知识库/知识页/审核/设置）+ 底部主题与语言切换。**图标态**，名称在 `aria-label` 与悬停标签里——左栏只有 72px，文字入口放不下。
- 中栏：内容自己滚，`max-width: 1280px` 居中。宽度不够时先让中栏变窄，而不是先牺牲右栏。
- 右栏（`ContextRail`）：全局搜索入口（回车跳 `/search?q=`）、**待审核**、**最近更新**。可折叠成 30px 把手，折叠状态记 `localStorage`（`repotory:context-rail-collapsed`），**折叠后不自动弹回**——记住的是这台机器上人上一次的选择。

**2. macOS 隐藏标题栏，让左栏「包住」交通灯。**

`main.go` 用 `mac.TitleBarHidden()`（`TitlebarAppearsTransparent` + `HideTitle` + `FullSizeContent`）：标题栏没了，交通灯还在，内容从窗口最顶端开始。左栏顶部整体让开 28px（原生标题栏的高度）+ 栏本身的 12px 呼吸位，交通灯落在栏内、品牌标记落在它们下面。

**3. 让出标题栏之后，窗口拖拽由中栏顶部的一条拖拽带接替。**

Wails 的拖拽判定读 `getComputedStyle(e.target).getPropertyValue('--wails-draggable')`，该属性**会继承**，所以拖拽面上声明 `--wails-draggable: drag`，而**每一个可交互的后代必须显式写 `none`**——否则品牌标记这种链接会变成拖拽把手，鼠标按下去拖不动也点不动。

拖拽带**不放左栏，放中栏顶部**：左栏只有 72px 宽，交通灯就占掉横向 9..68px，拖拽带压在交通灯上只剩一条 9px 的窄缝，拖不动；中栏顶部是一条整宽的带子，拖起来是正常窗口该有的手感。

**三栏内容整体让开同一条带子**（`--window-controls-inset: 28px`，只在 macOS 桌面构建生效）：那 28px 是原生标题栏的高度，其中的 webview 收不到点击——把内容排进去，就是排进一块点不到的地方。右栏的折叠按钮有一半正落在里面，改为整栏下移后才完整可点。

**4. 品牌标记只有一处，在左栏。**

旧导航栏删掉，`BrandMark` 的渲染点收敛到左栏一处。`BrandMark.test.tsx` 钉住两条：左栏的 `.brandMark` **不许有 `border-radius`**（品牌母图是方卡，hairline 框距边约 1.3px，任何可见圆角都会吃掉框的四角，标记读作撕裂的贴纸），以及首页助手头部**不许再渲染** `BrandMark`（一个首页出现三次 logo = 像三个产品）。

**5. 浮窗快提按钮锚到中栏右缘，不锚视口右缘。**

按钮是 `position: fixed; right: 22px`，右栏打开时它会浮在右栏上面。改为 `right: calc(var(--context-rail-offset) + 22px)`，其中 `--context-rail-offset` 由 `App` 按折叠态发布为 `--context-rail-width` 或 `--context-rail-collapsed-width`（CSS Modules 不改写自定义属性名，所以它能跨组件传值）。

**6. 产物目录名改成 `Repotory.app`，可执行文件名不动。**

`wails.json` 的 `name` 改为 `Repotory`（`outputfilename` 仍是 `repotory`），Homebrew Cask 的 `app` stanza 与 tap 的 `tests.yml` 断言同步改成 `Repotory.app`，DMG 卷名改为 `Repotory`。**二进制名 `repotory` 是 ADR-0006 的冻结标识**（绑定数据目录与 MCP 前缀 `repotory_*` 的迁移史），只改 bundle 目录这一层。

这一层改名**不动用户的数据**：`internal/platform` 的数据目录是硬编码常量 `dirName = "repotory"`（`~/Library/Application Support/repotory/repotory.db`、日志同 basename），**与 bundle 名无关**——所以改名前后装的是同一个库、同一份插件、同一个日志路径。**bundle 标识也没变**：Wails 的 `CFBundleIdentifier` 是 `com.wails.{{safeBundleID .Name}}`，而 `safeBundleID` 会把名字**转成小写**（`Repotory` → `repotory`），所以标识仍是 `com.wails.repotory`，macOS 的 LaunchServices 不会把它当成另一个应用。显示名（`CFBundleName`）取自 `info.productName`，本来就是 `Repotory`——**用户看到的小写一直是 bundle 的目录名**（`repotory.app`），不是显示名；改 `name` 才是改到了点子上。

**7. 右栏在窄屏隐藏（≤1024px），中栏在 ≤768px 收紧内边距。**

右栏是增强面，不是主面；屏幕不够时先让它走。

## 理由

- **左中右是桌面应用的共识形状**，因为它把「去哪」「在做什么」「还有什么在等我」三件事同时摆在视野里。旧的顶栏只回答了第一件，代价是吃掉一条横向空间；新的左栏回答第一件且只占 72px，腾出来的横向与纵向空间给了第三件。
- **隐藏标题栏不是为了好看，是为了把交通灯收进结构里。** 系统交通灯画在内容左上角这件事没法商量，但**内容在它下面怎么排**可以商量——把左栏顶部让出来，就变成「左栏包住关闭/最小化/全屏」，而不是「导航栏被三个圆点压住」。
- **右栏只复用已有绑定**，不新增后端面：`listPendingWikiPages(0)` 取待审核（`projectID=0` 即不按项目收窄），`browseWikiPages(0, 6)` 取最近更新的已批准页（后端已按 `updated_at DESC` 排序，且只回摘要行不回正文）。**刻意不用 `listAllNotes()` / `listApprovedWikiPages()`**——那两个会把全部笔记与全部已批准页的正文一次性搬进浏览器，右栏每次挂载都付这个代价不值得。
- **折叠态必须被记住**：右栏是常驻面，用户把它收起来是明确说过「别占地方」，下次启动再弹回来等于没听见。

## 后果

- 正面：横向空间还给了内容与右栏；macOS 构建的左上角不再有元素被交通灯压住；「待审核」与「最近更新」在一屏之内可达（此前各需一次导航）；应用在 Finder / Launchpad / `/Applications` 里以 `Repotory` 呈现。
- 负面：Windows/Linux 保留原生标题框，因此那两端的窗口顶部会多出一条系统标题栏——**跨三平台的外壳不可能逐像素一致**，本 ADR 选择「同一套左栏 + 各平台自己的窗口装饰」；旧 `/Applications/repotory.app` 在原地不动时，新装的 `Repotory.app` 会与它并存（macOS 默认文件系统大小写不敏感，同一路径会命中同一份，但打包目录与 CI 断言必须按新名书写，否则 tap 的 runner 大小写敏感会红）；右栏是**第二个**导航面，导航项增删要同时想「该不该在这里也出现一份入口」。
- 边界：**右栏的每个块都必须有等价的全页入口**（搜索 → `/search`、待审核 → `/review`、最近更新 → `/wiki`），否则右栏就成了唯一入口，违反 ADR-0024「顶级页有稳定锚点」的取向；**左栏不承载设置项以外的状态**（更新徽标除外），它是导航不是仪表盘。
- 已知限制：右栏的「待审核」与「最近更新」各自发一次请求，两次请求之间没有一致性保证（同页可能重复或漏一条）——真实影响极小（两个集合更新频率都很低），但**它不是快照**，文档与 UI 措辞都按「列表」而非「此刻的确切集合」表述。

## 实现修正

**1. `transport.call()` 不是 async，缺绑定时同步抛。** 右栏在 `useEffect` 里调 `listPendingWikiPages(0)`，而 Wails 传输层在绑定缺失时**同步**抛出（旧桌面二进制跑新前端、或测试 mock 没带这个方法）。`await` 拦不住同步抛——整个 effect 会把外壳带崩。故右栏用本地 `load()` 助手包住：`try { run().then(...) } catch { onFailure() }`，失败即降级成空列表。**右栏是装饰面，不值得为它崩掉整个 shell。**

**2. i18n 门禁的白名单跟着搬家。** 左栏的语言切换项要显示语言名本身（`中文` / `English`），这是源码里唯一允许的硬编码中文。`scripts/check-i18n-keys.mjs` 的 `ALLOW_CJK_IN_SRC` 条目因此从 `App.tsx` 移到 `components/SideRail.tsx`——**搬家而不是新增**，白名单每多一个文件就多一个漏检的口子。

**3. 品牌标记的圆角在改壳的过程中差点回潮。** 新写 `.brandMark` 时顺手加了 `border-radius: 4px`（旧导航栏时代留下的肌肉记忆），被 `BrandMark.test.tsx` 的 CSS 读取断言当场拦下——那个断言读的是样式表源码，因为**圆角是裁切不是样式，DOM 断言看不见它**。

**4. 拖拽带的高度照抄原生标题栏的 28px，是为了不赌命中测试。** 隐藏标题栏后，窗口顶部那一条到底归谁，本机没法用实验回答：合成鼠标事件（`CGEventPost`）能送达 webview（悬停标签会跟着出现），但 AppKit 不认合成事件带来的拖拽，`performWindowDragWithEvent:` 与原生标题栏拖拽都不动窗口，而本机终端没有辅助功能权限，真实拖拽无法脚本化。**两种可能都真实存在**：那条带子要么由 AppKit 的标题栏接管（webview 收不到事件），要么由 webview 接管（`--wails-draggable: drag` 生效）。

于是不赌：带子高度取 28px（= 原生标题栏高度），**两种情形下用户的动作完全一样**——从窗口顶部那条带子拖动窗口。带子归谁管都行，用户看到的界面、拖动的位置都不变；同时把三栏内容整体下移 28px，两种情形下都点得到。**这是一个「让两种未验证的可能收敛到同一个可观察行为」的设计，而不是一次猜测。**
