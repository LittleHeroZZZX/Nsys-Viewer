# nsys-viewer

在浏览器里查看并对比 NVIDIA Nsight Systems (`nsys`) 导出的 sqlite profile，
**聚焦 CUDA kernel 分析**的轻量小工具。

## 环境要求

- Python ≥ 3.11
- [`uv`](https://docs.astral.sh/uv/)

## 运行

```bash
# 首次或锁文件变化后同步依赖
uv sync

# 指定 profile 目录启动服务
uv run nsys-viewer --dir ~/Downloads/profile_results
# → http://127.0.0.1:8765
```

可选参数：

| 参数              | 默认值           | 说明                                |
| ----------------- | ---------------- | ----------------------------------- |
| `--dir, -d`       | `.`              | 存放 `*.sqlite` 的目录              |
| `--host`          | `127.0.0.1`      | 绑定的 host                          |
| `--port`          | `8765`           | 端口                                 |
| `--reload`        | off              | 代码变更自动 reload（开发用）        |

## 使用流程

1. 左侧栏会自动列出目录下的 sqlite 文件。
2. 顶部 **Single file / Compare** 切换模式。
   - **Single file**：单个文件的 kernel 统计（Total / Avg / Min / Max + 占比）。
   - **Compare**：勾选多个文件，按 kernel 显示各文件 Total 以及相对第一个
     文件（baseline）的 Δ%。**红色 = 变慢，绿色 = 变快**；只在某一边出现
     的 kernel 标记为 `new`。
3. **Group by**
   - `Short name`：去掉模板参数的函数名。比较时更容易对齐。
   - `Demangled (full)`：包含模板参数的完整名称。
4. **Top N**：展示行数。**Search**：kernel 名按子串过滤。
5. kernel 名点击后可换行展开，看完整签名。

## 读取的数据

主要查的表：

- `CUPTI_ACTIVITY_KIND_KERNEL` —— kernel 执行区间 (start, end, name)
- `CUPTI_ACTIVITY_KIND_MEMCPY` —— overview 卡片里的 memcpy 次数/耗时
- `TARGET_INFO_GPU` —— GPU 型号 / Compute Capability

聚合维度是 `demangledName` 或 `shortName`（与 `StringIds` 表 join 解出真名）。

## 目录结构

```
src/nsys_viewer/
├── cli.py        # argparse → uvicorn
├── server.py     # FastAPI 路由
├── db.py         # sqlite 查询 (overview / kernel_summary / compare)
└── web/          # 纯静态前端，无外部依赖
    ├── index.html
    ├── app.js
    └── style.css
```

API：

- `GET /api/files` —— 目录下所有 `*.sqlite`
- `GET /api/overview?file=<stem>`
- `GET /api/kernels?file=<stem>&group_by=<demangled|short>&limit=N`
- `GET /api/compare?files=<a,b,c>&group_by=…&limit=N`

## 后续扩展方向

当前只覆盖 kernel，结构上预留了空间，后续可在同一工具里加：

- NVTX 区间（`NVTX_EVENTS`）查看一段标记下的 kernel 组成
- Memcpy / stream 维度的时间线
- Kernel 执行的 GPU 占用率 timeline
- Kernel launch 与 GPU 执行的间隔（launch latency）分析
