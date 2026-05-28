# CLAUDE.md

本工具的 AI 协作指南。用中文交流。

## 项目定位

`nsys-viewer` 是一个本地小工具，把 NVIDIA Nsight Systems(`nsys`) 导出的
sqlite profile 用浏览器可视化，**当前主要关注 CUDA kernel 分析**（单文件
统计 + 多文件对比）。用户是模型部署性能优化方向，会反复跑 nsys、把若干
`*.sqlite` 放到同一目录下做横向对比。

## 技术栈与约定

- Python ≥ 3.11，依赖通过 [`uv`](https://docs.astral.sh/uv/) 管理。**不要**
  直接 `pip install` 或手改 `requirements.txt`；改依赖请编辑
  `pyproject.toml` 后 `uv sync`。
- 后端: FastAPI + uvicorn，sqlite 用标准库 `sqlite3` 以 `mode=ro` 只读打开。
- 前端: **纯静态**（`src/nsys_viewer/web/`），无构建步骤，无 CDN，不引入
  npm / bundler / 框架。需要新功能时优先在现有 `app.js` / `style.css` 里加；
  保持单文件、小体积。
- 启动入口: `uv run nsys-viewer --dir <profile_dir>`（见 `cli.py`）。
- 项目使用 git。**默认不要主动 commit**，等用户明确要求。

## 模块速览

```
src/nsys_viewer/
├── cli.py        # argparse → 启动 uvicorn，唯一 CLI 入口
├── server.py     # FastAPI 路由 + 静态文件挂载；create_app(root) 工厂
├── db.py         # 所有 SQL 集中在这里；对外暴露 list_sqlite_files /
│                 #   overview / kernel_summary / compare_kernels
└── web/          # 静态前端（index.html / app.js / style.css）
```

## nsys sqlite 关键 schema（避免每次重新摸索）

- `CUPTI_ACTIVITY_KIND_KERNEL` 一行 = 一次 kernel 执行。时间戳是
  **纳秒**：`end - start` 得到 duration。`demangledName` / `shortName` 都
  是指向 `StringIds(id, value)` 的整数 id，**必须 JOIN 才能拿到真名**。
- `shortName` 是去掉模板参数的函数名，跨文件对比时匹配率更高；
  `demangledName` 是带模板参数的完整签名，单文件细看时更准。前端 group
  by 切换就是切这两列。
- 不同 nsys 版本/不同 trace 配置可能缺表（比如没开 cuDNN trace 就没
  `CUDNN_EVENTS`）。`db._has_table()` 用来兜底；新加查询前先用它判一下。
- `CUPTI_ACTIVITY_KIND_KERNEL` 行数可达 5w+；查询都用聚合，**不要**
  `SELECT *` 全表拉到 Python 里再算。
- `TARGET_INFO_GPU` 一般只有一行，列名取决于版本——`overview()` 里用
  `row.keys()` 做了存在性判断，新增字段时沿用这个模式。

## 安全/路径处理

- `server.resolve_file()` 已经做了越界校验：参数只接受 stem（不含扩展名
  和路径分隔符），拼出绝对路径后用 `relative_to(root)` 检查不超出
  `--dir`。新增涉及文件名的接口请复用它，不要再裸拼路径。
- `db.overview()` 和 `db.kernel_summary()` 用了 `@lru_cache`，因为 sqlite
  文件被视为不可变。**如果将来支持原地覆盖/更新文件，得清缓存**
  （`overview.cache_clear()` 等）。

## 性能/UI 注意点

- 前端的"内联条形"用 CSS 宽度做，没用 Canvas/SVG 库。新增图表时优先
  延续这个思路；要画时间线时也尽量先尝试 CSS / 极少量 vanilla JS，
  能不引依赖就不引。
- 表格行数受 `--limit`（前端 `Top N`）保护，默认 50。任何返回数组的
  接口都应该有上限（看 `api_kernels` / `api_compare` 的 `Query(...,
  le=...)`）。
- 字段单位统一在**后端用纳秒**返回；格式化（µs / ms / s）放在前端
  `fmt.ns()`，不要混着来。

## 常用命令

```bash
uv sync                                                  # 同步依赖
uv run nsys-viewer --dir ~/Downloads/profile_results     # 启动
uv run nsys-viewer -d <dir> --reload                     # 改代码自动重启
```

快速 smoke test：

```bash
curl -s http://127.0.0.1:8765/api/files | python3 -m json.tool
curl -s "http://127.0.0.1:8765/api/overview?file=local_baseline" | python3 -m json.tool
curl -s "http://127.0.0.1:8765/api/compare?files=local_baseline,local_baseline_fp16&group_by=short&limit=5" | python3 -m json.tool
```

## 扩展时优先考虑

按用户兴趣顺序：

1. NVTX 区间分析（`NVTX_EVENTS` + range → 区间内 kernel 组成）
2. Memcpy / stream 维度
3. Kernel launch latency（`CUPTI_ACTIVITY_KIND_RUNTIME` ↔ KERNEL 关联）
4. Kernel timeline / GPU 占用率

加新能力时，**保持单一可执行入口**（`nsys-viewer`），在前端用 tab 而不是
另外起服务。
