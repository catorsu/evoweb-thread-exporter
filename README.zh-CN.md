# Evo-Web Thread Exporter

[English](README.md) | [简体中文](README.zh-CN.md)

用于将 Evo-Web 主题帖导出到本地文件夹的 Chrome 扩展，支持帖子正文、引用、链接和论坛原生附件。

## 安装与使用

1. 在用于访问 Evo-Web 的 Chrome 用户配置中打开 `chrome://extensions`。
2. 启用**开发者模式**，点击**加载已解压的扩展程序**，选择本项目中的 `evoweb-exporter-extension` 文件夹。
3. 打开 `https://evoweb.uk` 上的主题帖，并根据需要登录账号。
4. 打开 Chrome 的扩展程序菜单，选择 **Evo-Web Thread Exporter**。
5. 在页面面板中点击 **Choose folder & export**（选择文件夹并导出）。如果出现提示，点击 **Grant write access & export**（授予写入权限并导出），并允许 Chrome 访问所选文件夹。
6. 保持标签页打开，直到导出完成。需要提前停止时，点击 **Stop & save partial**（停止并保存已导出的内容），以终止当前传输并保存已有报告。

更新扩展文件后，请在 `chrome://extensions` 中点击扩展的重新加载按钮，再刷新主题帖页面并打开导出面板。无需执行构建步骤。如果移动或重命名了项目目录，请从新位置重新加载已解压的扩展程序。

## 导出范围

扩展读取主题帖中发现的分页，记录每条帖子的作者、日期、永久链接、正文、引用和链接。论坛原生的图片、压缩包、文档及其他非音视频附件会在可用时保存到本地。

- 外部链接仅作为文本引用保留，不下载链接目标。
- 引用内容中的附件默认仅保留引用。
- YouTube 等嵌入式播放器仅保留引用。默认不下载视频和音频文件。
- 能够识别的视频或音频文件会在发起请求前跳过；无法预先识别的类型，会在响应头表明其为视频或音频时取消传输。
- 返回 HTTP 404 或 410 的附件会记为不可用，不会计入已保存文件。

## 输出内容

每次导出都会在所选文件夹内创建一个新目录：

```text
thread-<id>_<title>_<timestamp>_<run-id>/
├── manifest.json
├── thread.txt
└── posts/
    └── post-<id>/
        └── <category>/
            └── <attachment-id>__<filename>
```

`thread.txt` 是便于阅读的文本报告。`manifest.json` 保存结构化帖子数据、文件路径、状态和诊断信息。两份报告中的路径均相对于所选文件夹。每处理完一页都会更新报告，只有文件写入提交成功后才会标记为已保存。

| 状态                                    | 含义                                                         |
| --------------------------------------- | ------------------------------------------------------------ |
| `finished`                              | 导出完成，未检测到错误或不可用附件。                         |
| `finished-with-unavailable-attachments` | 导出完成，但部分附件返回 HTTP 404 或 410。                   |
| `finished-with-errors-or-gaps`          | 页面、附件或内容提取检查出现问题，需要查看报告中的诊断信息。 |
| `stopped-partial`                       | 导出在完成前停止。                                           |

按规则跳过音视频或仅保留引用不算错误。`finished` 表示本次导出检查通过，并不保证源网站曾经发布的所有内容仍然存在。

## 权限说明

扩展申请 `scripting` 权限以显示导出面板，并申请访问 Evo-Web 和 HTTPS Cloudflare R2 存储的主机权限。附件下载在扩展的后台工作线程中执行，因为 R2 可能未提供页面脚本读取响应所需的 CORS 响应头。

Chrome 会根据域名范围提供登录 Cookie。扩展不申请 cookies API 权限，不索取密码，不上传导出内容，也不使用第三方代理。后台工作线程仅接受论坛原生附件地址作为请求起点；主机权限、响应校验和内容安全策略共同限制存储访问范围。

权限模型可参阅 Chrome 的[跨源网络请求文档](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)。

## 常见问题

- **导出面板未显示：** 确保当前页面是普通的 Evo-Web 主题帖，检查扩展的网站访问权限，并在重新加载扩展后刷新标签页。
- **返回 HTTP 401/403 或 HTML 页面：** 登录账号，检查附件能否在 Evo-Web 中正常打开。如网站要求验证，请在浏览器中完成验证。
- **返回 HTTP 404/410：** 请求地址上的附件不可用。重复导出无法恢复服务器上已删除的文件。
- **无法访问文件夹：** 选择可写入的文件夹，通过页面按钮授予权限。取消或拒绝授权后可以重试。
- **导出中断或报告内容缺失：** 在重新导出前检查 `manifest.json` 和 `thread.txt`。每次导出使用独立目录。

## 开发

项目名称为 **Evo-Web Thread Exporter**，项目目录和 npm 包名统一使用 `evoweb-thread-exporter`。扩展源码位于 `evoweb-exporter-extension/`，可直接加载到 Chrome。

使用 Node.js 22 或更高版本，在项目根目录执行：

```sh
npm ci
npm run check
npm test
npm run format:check
```

源码结构、测试范围和维护规范见[开发指南（英文）](docs/development.md)。导出目录、本地审计报告和生成的测试输出均由 Git 忽略。
