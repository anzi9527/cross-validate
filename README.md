# Cross-Validate 跨模型交叉校验工具

[![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-blue)](https://python.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Cross-validate 是一个 AI 驱动的内容与代码审核工具**，利用国产大模型（智谱 GLM-4-Flash、通义千问）对生成的内容和代码进行二次校验，降低 AI 幻觉。

> 纯国产大模型，免费额度，无需科学上网。特别适合国内开发者和内容创作者。

---

## 功能

- **文章审核** — AI 生成的技术文章、日报、周报的事实核查和质量评估
- **代码审查** — Python 代码语法、逻辑、安全的自动化检查
- **案例校验** — AI 工程踩坑案例的可靠性验证
- **零依赖** — 纯 Python 标准库，不依赖任何第三方包
- **零成本** — 使用智谱 GLM-4-Flash 免费额度，无需付费
- **可集成** — 可以嵌入任何 Python 流水线，输出结构化 JSON

## 快速开始

### 1. 获取

```bash
git clone https://github.com/anzi9527/cross-validate.git
cd cross-validate

# 无需 pip install，纯标准库
```

### 2. 配置 API Key

去 [智谱开放平台](https://open.bigmodel.cn/usercenter/project) 免费注册，获取 API Key。

```bash
# Windows PowerShell
$env:ZHIPU_API_KEY="your-api-key-here"

# Linux/Mac
export ZHIPU_API_KEY="your-api-key-here"
```

### 3. 使用

```bash
# 审核一篇文章
python3 cross_validate.py article.md

# 审核一段代码
python3 cross_validate.py my_script.py code

# 直接审核文本
python3 cross_validate.py --text "要审核的内容" article

# CI 模式：有严重问题则退出码 1
python3 cross_validate.py code_to_review.py code --exit-on-fail
```

### 4. 在 Python 中调用

```python
from cross_validate import validate_content, validate_file, check_key_status

# 审核文本
result = validate_content("你的文章内容...", content_type="article")
print(result["score"])    # "pass" | "warn" | "fail"

# 审核文件
result = validate_file("path/to/code.py", content_type="code")

# 检查 API 状态
print(check_key_status())
```

## 输出格式

```json
{
  "validated": true,
  "model": "zhipu",
  "score": "pass",
  "summary": "内容通顺，事实准确，无明显问题",
  "issues": [
    {
      "severity": "low",
      "type": "suggestion",
      "description": "建议补充具体的代码示例"
    }
  ]
}
```

### severity 等级

| 等级 | 含义 | 行动 |
|------|------|------|
| `high` | 严重问题 | 必须修改 |
| `medium` | 中等风险 | 建议检查 |
| `low` | 优化建议 | 选择性采纳 |

### content_type 支持

| 类型 | 适用场景 |
|------|---------|
| `article` | 技术文章、日报、博客 |
| `code` | Python 代码检查 |
| `case_study` | AI 工程踩坑案例 |

## 支持的模型

| 模型 | 环境变量 | 免费额度 | 注册链接 |
|------|---------|---------|---------|
| **智谱 GLM-4-Flash** | `ZHIPU_API_KEY` | 有免费额度 | [注册](https://open.bigmodel.cn/usercenter/project) |
| **通义千问 qwen-turbo** | `DASHSCOPE_API_KEY` | 有免费额度 | [注册](https://help.aliyun.com/zh/model-studio/) |

默认优先使用智谱，未配置时自动回退到通义千问。两者都未配置时返回 `validated: false`。

## 仓库结构

```
cross-validate/
├── cross_validate.py   # 核心工具（主文件）
├── README.md           # 本文档
├── LICENSE             # MIT License
└── examples/           # 使用示例（开发中）
```

## License

MIT License

## Star

如果觉得有用，欢迎 star！也欢迎提 issue 和 PR。
