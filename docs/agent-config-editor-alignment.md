# Agent Config 编辑器对齐

Eval 与 SP 共用 `@springbrand/agent-config-editor`，不复制 SP 应用源码，不保留 JSON 配置编辑器。公共模块拥有行为、系统提示词、模型、思考强度、Connector Toolkit、Component Connector、Extension、Action、Skill 和 Reference 的表单与选择、排序、移除、管理和预览。

新建从 Eval SP 的默认模板初始化，名称、描述由用户填写；Slug 在一次创建会话开始时生成，重试沿用。创建与编辑直接使用 SP 的公开输入校验、配置正文和 revision；未知创建结果通过相同 Slug 校准，不能重复创建。取消未提交的表单不写配置。冻结 Project 副本仍只读，不能经资源目录入口绕过冻结保护。

公共编辑器只接受宿主注入的 HTTP 客户端和导航，不持有凭据、SP 应用路由、数据库或运行时。SP Web 与 Eval Web 都消费同一公共实现。模型和资源目录从当前 Eval SP 的公开接口读取，不使用生产 SP 数据或本地枚举副本。

Eval API 在现有 Web 网关和固定服务账号作用域内提供 `/api/agent-library`：仅开放默认模板、模型目录、Skills、Actions、Components、Connectors、References 和 Reference 附件所需的明确路径与方法。正文由 SP 校验，Eval 保留请求体限长、错误翻译、取消信号和 Origin 校验；不提供任意 URL 转发，不将服务账号会话交给浏览器。Agent Config 写入仍走既有 `/api/agent-configs` 冻结保护。

公共 Agent 编辑器的领域错误和删除阻挡详情从 SP 唯一错误目录选取，服务端与浏览器均用同一 Eval HTTP 目录解码。删除预检查与实际删除之间新增的活跃工作仍能显示真实阻挡原因；未经 Schema 校验的详情不公开。SP 服务会话失效是依赖不可用，不能清除浏览器登录。

共享包暂按已有本地联调方式接入。正式发布前需升级精确 npm 版本、更新锁文件并验证干净安装与 CI，不保留旧编辑器或格式兼容分支。
