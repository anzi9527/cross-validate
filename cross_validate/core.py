#!/usr/bin/env python3
"""
跨模型交叉校验工具
用第二个模型审核 AI 生成内容，降低幻觉

支持：
- 智谱 GLM-4-Flash（免费额度）
- 通义千问 qwen-turbo（免费额度，需手动注册 Key）

使用方法：
1. 去 https://open.bigmodel.cn/usercenter/project 注册智谱 API Key（免费）
   或 https://help.aliyun.com/zh/model-studio/ 注册通义千问（免费额度）
2. 把 Key 填到 openclaw.json 的 env 里：
   "env": {
     "ZHIPU_API_KEY": "your-key-here",
     "DASHSCOPE_API_KEY": "your-key-here"
   }
   或直接设置环境变量
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import urllib.request
from typing import Any

__version__ = "0.2.0"

# 从 openclaw.json 读取 API Key
def _load_key_from_config(key_name: str) -> str:
    """从 openclaw 配置读取 Key，先环境变量、后配置文件。"""
    # 1. 先检查环境变量
    val = os.environ.get(key_name, "")
    if val:
        return val

    # 2. 从 openclaw.json 读取
    config_path = os.path.expanduser("~/.openclaw/openclaw.json")
    try:
        with open(config_path, encoding="utf-8-sig") as f:
            cfg = json.load(f)
        return cfg.get("env", {}).get(key_name, "")
    except (FileNotFoundError, json.JSONDecodeError):
        return ""


ZHIPU_API_KEY = _load_key_from_config("ZHIPU_API_KEY")
DASHSCOPE_API_KEY = _load_key_from_config("DASHSCOPE_API_KEY")


def _call_provider(
    api_key: str,
    url: str,
    model: str,
    provider_name: str,
    system_prompt: str,
    user_prompt: str,
    timeout: int = 90,
) -> str | None:
    """通用 OpenAI 兼容 chat/completions 调用。

    智谱与通义千问都暴露 OpenAI-compatible 的 /chat/completions 端点，
    区别仅在 URL、模型名与鉴权 header，因此收敛为一个可复用的函数。
    """
    if not api_key:
        return None

    data = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.3,
        "max_tokens": 1024,
    }).encode()

    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            result = json.loads(resp.read().decode())
            return result["choices"][0]["message"]["content"]
    except Exception as e:  # noqa: BLE001 - 网络/解析错误交给调用方
        print(f"  ⚠️ {provider_name}调用失败: {e}", file=sys.stderr)
        return None


def _call_zhipu(system_prompt: str, user_prompt: str) -> str | None:
    """调用智谱 GLM-4-Flash（免费版）"""
    return _call_provider(
        ZHIPU_API_KEY,
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        "GLM-4-Flash",
        "智谱",
        system_prompt,
        user_prompt,
    )


def _call_dashscope(system_prompt: str, user_prompt: str) -> str | None:
    """调用通义千问 qwen-turbo（免费额度）"""
    return _call_provider(
        DASHSCOPE_API_KEY,
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        "qwen-turbo",
        "通义千问",
        system_prompt,
        user_prompt,
    )


def _call_secondary(system_prompt: str, user_prompt: str) -> str | None:
    """调用已配置的次要模型（优先智谱，回退到通义）"""
    result = _call_zhipu(system_prompt, user_prompt)
    if result:
        return result
    return _call_dashscope(system_prompt, user_prompt)


def _extract_json(text: str) -> dict[str, Any] | None:
    """从模型输出中尽力解析一个 JSON 对象。

    模型有时会：
    - 输出纯 JSON；
    - 用 markdown 代码块包裹 JSON（```json ... ```）；
    - 把 JSON 混在自然语言里。
    此函数按上面顺序逐一尝试，全部失败返回 None。
    """
    if not text:
        return None
    # 尝试直接解析
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    # 尝试从 markdown 代码块提取
    m = re.search(r"```(?:json)?\s*\n?([\s\S]*?)\n?```", text)
    if m:
        try:
            return json.loads(m.group(1))
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
    # 尝试找第一个 { ... } JSON 对象（按大括号深度平衡匹配）
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                try:
                    return json.loads(text[start : i + 1])
                except (json.JSONDecodeError, TypeError, ValueError):
                    start = -1
    return None


_VALID_TYPES = ("article", "code", "case_study")


def _type_prompt(content_type: str) -> str:
    """按内容类型选择 review prompt。"""
    if content_type == "code":
        return """你是一个资深的 Python 代码审查专家。请严格检查以下代码：
1. 语法是否正确
2. 是否有逻辑错误或边界情况
3. 变量命名是否合理
4. 是否有安全漏洞
5. 依赖是否合理

用 JSON 格式输出审核结果：
{"issues": [{"severity":"high|medium|low","type":"code_bug|logic_issue|suggestion","description":"..."}], "summary":"总体评价（一句话）", "score":"pass|warn|fail"}"""
    if content_type == "case_study":
        return """你是一个经验丰富的 AI 工程落地专家。请审核以下踩坑案例：
1. 问题描述是否真实可信
2. 根因分析是否合理
3. 解决方案是否可复现
4. 是否有明显的事实错误

用 JSON 格式输出审核结果：
{"issues": [{"severity":"high|medium|low","type":"factual_error|logic_issue|suggestion","description":"..."}], "summary":"总体评价", "score":"pass|warn|fail"}"""
    return """你是一个严谨的事实核查员和技术编辑。请审核以下内容：
1. 是否有事实错误
2. 逻辑是否自洽
3. 是否有夸大或误导性表述
4. 引用和数字是否合理

用 JSON 格式输出审核结果：
{"issues": [{"severity":"high|medium|low","type":"factual_error|logic_issue|suggestion","description":"..."}], "summary":"总体评价", "score":"pass|warn|fail"}"""


def validate_content(
    content: str,
    content_type: str = "article",
    sources: str | None = None,
    max_content: int = 4000,
) -> dict:
    """
    用第二个模型审核内容

    参数:
        content: 要审核的内容文本
        content_type: 内容类型
            - "article": 技术文章/日报
            - "code": Python 代码片段
            - "case_study": 踩坑案例/解决方案
        sources: 数据来源描述/链接列表（可选）。提供后，
                 审核 prompt 会附带这些来源信息，帮助模型
                 基于外部源判断事实而非依赖自己的知识库。
        max_content: 发送给模型的正文长度上限（默认 4000 字符）。

    返回:
        {
            "validated": True/False,  # 是否成功执行了审核
            "model": "zhipu" / "dashscope" / "",
            "issues": [
                {"severity": "high"|"medium"|"low", "type": "factual_error"|"logic_issue"|"code_bug"|"suggestion", "description": "..."}
            ],
            "summary": "审核总结",
            "score": "pass"|"warn"|"fail"
        }
    """
    if not ZHIPU_API_KEY and not DASHSCOPE_API_KEY:
        return {
            "validated": False,
            "reason": "未配置校验 API Key（请注册智谱 https://open.bigmodel.cn 获取免费 Key）",
            "issues": [],
            "score": "unknown",
        }

    if content_type not in _VALID_TYPES:
        content_type = "article"
    system_prompt = _type_prompt(content_type)

    # 限制内容长度
    truncated = content[:max_content]
    if len(content) > max_content:
        truncated += f"\n...（内容过长已截断，仅审核前{max_content}字）"

    if sources:
        source_block = (
            "\n\n=== 数据来源信息（请基于以下来源判断事实，不要仅依赖你自己的知识库）===\n"
            f"{sources[:2000]}\n=== 来源信息结束 ===\n"
        )
    else:
        source_block = ""

    type_label = "代码" if content_type == "code" else "案例" if content_type == "case_study" else "文章"
    user_prompt = f"请审核以下{type_label}：{source_block}\n\n{truncated}"

    response = _call_secondary(system_prompt, user_prompt)
    if not response:
        return {
            "validated": False,
            "reason": "API 调用失败",
            "issues": [],
            "score": "unknown",
        }

    model_used = "zhipu" if ZHIPU_API_KEY else "dashscope"
    parsed = _extract_json(response)
    if parsed and isinstance(parsed, dict) and "score" in parsed:
        parsed["validated"] = True
        parsed["model"] = model_used
        return parsed

    # 如果模型没输出可解析的 JSON，返回原始文本
    return {
        "validated": True,
        "model": model_used,
        "raw_response": response,
        "issues": [],
        "summary": response[:500],
        "score": "unknown",
    }


def validate_file(
    filepath: str,
    content_type: str = "article",
    sources: str | None = None,
    max_content: int = 4000,
) -> dict:
    """审核文件"""
    try:
        with open(filepath, encoding="utf-8") as f:
            content = f.read()
    except FileNotFoundError:
        return {"validated": False, "reason": f"文件不存在: {filepath}"}

    return validate_content(content, content_type, sources=sources, max_content=max_content)


def check_key_status() -> dict:
    """检查 API Key 配置状态"""
    return {
        "zhipu": bool(ZHIPU_API_KEY),
        "dashscope": bool(DASHSCOPE_API_KEY),
        "any_available": bool(ZHIPU_API_KEY or DASHSCOPE_API_KEY),
        "zhipu_key_prefix": ZHIPU_API_KEY[:8] + "..." if ZHIPU_API_KEY else "",
        "dashscope_key_prefix": DASHSCOPE_API_KEY[:8] + "..." if DASHSCOPE_API_KEY else "",
    }


def _read_sources(source_arg: str) -> str | None:
    """读取 --sources=<file> 指定的来源文件内容。"""
    src_path = source_arg.split("=", 1)[1]
    try:
        with open(src_path, encoding="utf-8") as f:
            return f.read()[:2000]
    except Exception as e:  # noqa: BLE001
        print(f"⚠️ 无法读取数据源文件 {src_path}: {e}", file=sys.stderr)
        return None


def _reconfigure_stdio() -> None:
    """在脚本入口重建 UTF-8 stdout/stderr。

    之前在模块顶层直接替换，导致作为库 import 时会污染调用方的标准流；
    现在仅在作为脚本运行时执行，且被调用方 import 时不会再被改变。
    """
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name)
        buffer = getattr(stream, "buffer", None)
        if buffer is not None:
            setattr(sys, name, io.TextIOWrapper(buffer, encoding="utf-8", errors="replace"))


def main() -> int:
    args = sys.argv[1:]

    if not args or args[0] in ("-h", "--help"):
        status = check_key_status()
        print("🔍 跨模型交叉校验工具")
        print("\nAPI Key 状态:")
        print(f"  智谱 GLM-4-Flash: {'✅ 已配置' if status['zhipu'] else '❌ 未配置'}")
        print(f"  通义千问 qwen-turbo: {'✅ 已配置' if status['dashscope'] else '❌ 未配置'}")
        print(f"  总状态: {'✅ 可用' if status['any_available'] else '❌ 不可用（需注册 API Key）'}")
        print("\n用法:")
        print("  python3 cross_validate.py <文件路径> [article|code|case_study] [--sources=<来源文件>]")
        print("  python3 cross_validate.py --text <\"文本内容\"> [article|code|case_study] [--sources=<来源文件>]")
        print("  python3 cross_validate.py --check  查看 Key 状态")
        print("  python3 cross_validate.py --version  查看版本")
        return 0

    if args[0] in ("-V", "--version"):
        print(f"cross-validate {__version__}")
        return 0

    if args[0] == "--check":
        status = check_key_status()
        print(json.dumps(status, indent=2, ensure_ascii=False))
        return 0

    # 解析可选的数据源文件参数
    source_text = None
    file_args = [a for a in args if not a.startswith("--sources=")]
    source_arg = [a for a in args if a.startswith("--sources=")]
    if source_arg:
        source_text = _read_sources(source_arg[0])

    if not file_args:
        print("❌ 缺少必填参数，用 -h 查看用法", file=sys.stderr)
        return 1

    if file_args[0] == "--text" and len(file_args) >= 2:
        content = file_args[1]
        content_type = file_args[2] if len(file_args) >= 3 else "article"
        result = validate_content(content, content_type, sources=source_text)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0

    # 审核文件
    filepath = file_args[0]
    content_type = file_args[1] if len(file_args) >= 2 else "article"
    result = validate_file(filepath, content_type, sources=source_text)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    _reconfigure_stdio()
    raise SystemExit(main())