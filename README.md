# DSH GPT Fast

DeepSeek Harness 的实验性插件，为指定供应商和模型的 OpenAI 兼容 HTTP 请求设置 `service_tier: "priority"`。提供全局 Fast 开关、状态、计数和斜杠命令。

## 工作方式与安全边界

本版在 DSH 进程内按供应商、模型和 HTTPS 地址匹配请求，**不启动本机代理端口，不要求将供应商地址改为 localhost**。原有供应商、凭据设置和 HTTPS 连接保持不变。旧版本使用过本地代理：升级前应先将供应商地址恢复为原始中转地址。

当前 DSH 的 pi-ai 适配器没有公开请求体改写接口。本插件使用 `llm/stream` 中间件、异步上下文及进程级 `fetch` 包装实现兼容，属于**实验性方案，不是宿主正式稳定的请求体扩展 API**。它有以下限制：

- 目前基于 DSH 0.2.1-rc.5 的 pi-ai HTTP 请求路径进行验证；其他 DSH 或依赖版本可能不兼容。
- 只处理配置的供应商、模型和 HTTPS base URL，且仅匹配 Responses 与 Chat Completions 端点的特定 JSON 请求形式。WebSocket、自定义或预先缓存的 `fetch`、其他进程与传输方式可能绕过拦截。
- 因此，**开关显示开启不保证每次请求都注入参数**，注入计数也不能证明中转站或上游实际采用了 Fast。是否接受、实际服务等级、额度和价格以供应商为准。
- 启用时，已识别但无法安全改写的目标请求会失败，而不是猜测如何修改；例如非标准序列化 JSON、重复键、某些数字形式和已识别的签名请求会被拒绝。某些自定义签名格式无法可靠识别，不应在签名请求中使用。其他请求保持透传。
- 作用域依赖异步上下文：目标流派生的独立异步任务，若在流结束前访问同一地址和模型，也可能被注入 Fast；这可能产生额外费用。
- `fetch` 是进程级共享对象；插件尽量限定作用域并在卸载时保留后安装的包装器，但与其他插件或未来宿主实现仍可能冲突。DSH 插件共享宿主权限，不是彼此隔离的安全沙箱。仅安装可信插件。

## 安装与配置

需要支持本地 Cordis 插件和 `connection.fetch` 的 DeepSeek Harness、Node.js，以及支持 `service_tier` 的 OpenAI 兼容中转：

```bash
git clone https://github.com/ZHI00/dsh-gpt-fast.git
cd dsh-gpt-fast
dsh plugin --profile desktop add "$(pwd)"
```

将 `desktop` 换成实际配置档；桌面发行版使用其自带的 `dsh` 命令。安装是本地目录链接，后续不要移动或删除该目录；本项目不发布 npm 包。

插件默认未配置。在对应 profile 的 Cordis patch 中加入如下条目，修改前备份原文件并保留已有配置：

```yaml
- id: dsh-gpt-fast-local
  config:
    provider: your-provider-id
    baseURL: https://your-relay.example/v1
    models:
      - your-exact-gpt-model-id
```

`provider` 和 `models` 必须是 DSH 中的精确 ID；`baseURL` 必须与该供应商原 HTTPS 地址一致，不能包含密钥、用户信息、查询字符串或片段。**不要改变供应商的原地址或 API Key 配置。** 如果以后更改原供应商地址、模型或协议，也要同步更新插件配置。

根据桌面版要求重新加载 profile 或重启 DSH。客户端模块和运行时钩子是否已加载，需在实际插件详情中核验；文件存在不代表已生效。

## 使用

在插件详情使用 **Fast 模式**开关，或在对话框执行：

- `/gpt-fast on`：开启 Fast。
- `/gpt-fast off`：关闭 Fast。
- `/gpt-fast status`：查看运行状态与计数。

详情开关和命令共用同一插件实例状态，不按会话区分。重启或重新加载插件后恢复关闭。详情页的插件启停开关控制的是整个插件，不等同于 Fast 开关。

## 测试

```bash
npm test
```

常规测试使用合成输入和模拟 fetch，不访问真实中转。`adapter.integration.test.js` 可以在本机安装的 DSH Electron Node 环境中，通过设置 `DSH_ASAR_NODE_MODULES` 运行，使用假凭据、假 fetch 和假 SSE 验证真实 pi-ai Responses 适配器；它不是完整桌面界面或真实服务端验证。

已覆盖开关、并发、嵌套、取消、卸载、目标匹配和认证控制逻辑。当前尚未对所有 DSH 版本、其他插件组合、真实中转或上游计费进行端到端验证。

## 许可证

[MIT](LICENSE)
