#!/usr/bin/env python3
"""
cross_validate.py — 跨模型交叉校验工具

用第二个模型审核 AI 生成内容，降低幻觉。
支持智谱 GLM-4-Flash（默认）和通义千问 qwen-turbo（回退）。

使用方法：
    python3 cross_validate.py <文件路径> [article|code|case_study]
    python3 cross_validate.py --text "<内容>" [article|code|case_study]
    python3 cross_validate.py --check

环境变量：
    ZHIPU_API_KEY      智谱 GLM-4-Flash API Key（推荐，有免费额度）
    DASHSCOPE_API_KEY  通义千问 qwen-turbo API Key（可选回退）

注册地址：
    智谱: https://open.bigmodel.cn/usercenter/project
    通义: https://help.aliyun.com/zh/model-studio/
"""

import io
import sys
import json
import os
import urllib.request
from typing import Optional

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')


def _load_key(key_name: str) -> str:
    """加载 API Key，优先级：环境变量 > 配置文件"""
    # 1. 环境变量
    val = os.environ.get(key_name, "")
    if val:
        return val

    # 2. 同级 config.json
    config_path = os.path.join(os.path.dirname(__file__), "config.json")
    try:
        with open(config_path, encoding="utf-8-sig") as f:
            cfg = json.load(f)
        val = cfg.get("env", {}).get(key_name, "")
        if val:
            return val
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    # 3. 用户目录 ~/.openclaw/openclaw.json
    config_path = os.path.expanduser("~/.openclaw/openclaw.json")
    try:
        with open(config_path, encoding="utf-8-sig") as f:
            cfg = json.load(f)
        val = cfg.get("env", {}).get(key_name, "")
        if val:
            return val
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    return ""


ZHIPU_API_KEY = _load_key("ZHIPU_API_KEY")
DASHSCOPE_API_KEY = _load_key("DASHSCOPE_API_KEY")


def _call_zhipu(system_prompt: str, user_prompt: str) -> Optional[str]:
    """调用智谱 GLM-4-Flash（免费版）"""
    if not ZHIPU_API_KEY:
        return None

    url = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
    data = json.dumps({
        "model": "GLM-4-Flash",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.3,
        "max_tokens": 1024,
    }).encode()

    req = urllib.request.Request(
        url, data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {ZHIPU_API_KEY}",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            result = json.loads(resp.read().decode())
            return result["choices"][0]["message"]["content"]
    except Exception as e:
        print(f"  [x] 智谱调用失败: {e}", file=sys.stderr)
        return None


def _call_dashscope(system_prompt: str, user_prompt: str) -> Optional[str]:
    """调用通义千问 qwen-turbo（免费额度）"""
    if not DASHSCOPE_API_KEY:
        return None

    url = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    data = json.dumps({
        "model": "qwen-turbo",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.3,
        "max_tokens": 1024,
    }).encode()

    req = urllib.request.Request(
        url, data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {DASHSCOPE_API_KEY}",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            result = json.loads(resp.read().decode())
            return result["choices"][0]["message"]["content"]
    except Exception as e:
        print(f"  [x] 通义千问调用失败: {e}", file=sys.stderr)
        return None


def _call_secondary(system_prompt: str, user_prompt: str) -> Optional[str]:
    """调用已配置的次要模型（优先智谱，回退到通义）"""
    result = _call_zhipu(system_prompt, user_prompt)
    if result:
        return result
    return _call_dashscope(system_prompt, user_prompt)


def validate_content(content: str, content_type: str = "article") -> dict:
    """
    用第二个模型审核内容。

    参数:
        content:      要审核的内容文本
        content_type: 内容类型（article / code / case_study）

    返回:
        {
            "validated": True/False,
            "model": "zhipu" / "dashscope" / "",
            "score": "pass" / "warn" / "fail" / "unknown",
            "summary": "审核总结",
            "issues": [{"severity": "high|medium|low", "type": "...", "description": "..."}]
        }
    """
    if not ZHIPU_API_KEY and not DASHSCOPE_API_KEY:
        return {
            "validated": False,
            "reason": "未配置 API Key。请注册智谱 https://open.bigmodel.cn 获取免费 Key",
            "issues": [],
            "score": "unknown",
        }

    # 根据内容类型选择 prompt
    if content_type == "code":
        system_prompt = (
            "你是一个资深的 Python 代码审查专家。请严格检查以下代码：\n"
            "1. 语法是否正确\n"
            "2. 是否有逻辑错误或边界情况\n"
            "3. 变量命名是否合理\n"
            "4. 是否有安全漏洞\n"
            "5. 依赖是否合理\n\n"
            '用 JSON 格式输出审核结果：\n'
            '{"issues": [{"severity":"high|medium|low","type":"code_bug|logic_issue|suggestion","description":"..."}], '
            '"summary":"总体评价（一句话）", "score":"pass|warn|fail"}'
        )
    elif content_type == "case_study":
        system_prompt = (
            "你是一个经验丰富的 AI 工程落地专家。请审核以下踩坑案例：\n"
            "1. 问题描述是否真实可信\n"
            "2. 根因分析是否合理\n"
            "3. 解决方案是否可复现\n"
            "4. 是否有明显的事实错误\n\n"
            '用 JSON 格式输出审核结果：\n'
            '{"issues": [{"severity":"high|medium|low","type":"factual_error|logic_issue|suggestion","description":"..."}], '
            '"summary":"总体评价", "score":"pass|warn|fail"}'
        )
    else:
        system_prompt = (
            "你是一个严谨的事实核查员和技术编辑。请审核以下内容：\n"
            "1. 是否有事实错误\n"
            "2. 逻辑是否自洽\n"
            "3. 是否有夸大或误导性表述\n"
            "4. 引用和数字是否合理\n\n"
            '用 JSON 格式输出审核结果：\n'
            '{"issues": [{"severity":"high|medium|low","type":"factual_error|logic_issue|suggestion","description":"..."}], '
            '"summary":"总体评价", "score":"pass|warn|fail"}'
        )

    max_content = 3000
    truncated = content[:max_content]
    if len(content) > max_content:
        truncated += "\n...（内容过长已截断，仅审核前3000字）"

    type_label = {'code': '代码', 'case_study': '案例'}.get(content_type, '文章')
    user_prompt = f"请审核以下{type_label}：\n\n{truncated}"

    response = _call_secondary(system_prompt, user_prompt)
    if not response:
        return {
            "validated": False,
            "reason": "API 调用全部失败",
            "issues": [],
            "score": "unknown",
        }

    model_used = "zhipu" if ZHIPU_API_KEY else "dashscope"
    try:
        result = json.loads(response)
        result["validated"] = True
        result["model"] = model_used
        return result
    except (json.JSONDecodeError, KeyError):
        return {
            "validated": True,
            "model": model_used,
            "raw_response": response,
            "issues": [],
            "summary": response[:500],
            "score": "unknown",
        }


def validate_file(filepath: str, content_type: str = "article") -> dict:
    """审核文件"""
    try:
        with open(filepath, encoding="utf-8") as f:
            content = f.read()
    except FileNotFoundError:
        return {"validated": False, "reason": f"文件不存在: {filepath}"}
    except Exception as e:
        return {"validated": False, "reason": f"读取文件失败: {e}"}

    return validate_content(content, content_type)


def check_key_status() -> dict:
    """检查 API Key 配置状态"""
    return {
        "zhipu": bool(ZHIPU_API_KEY),
        "dashscope": bool(DASHSCOPE_API_KEY),
        "any_available": bool(ZHIPU_API_KEY or DASHSCOPE_API_KEY),
        "zhipu_key_prefix": ZHIPU_API_KEY[:8] + "..." if ZHIPU_API_KEY else "",
        "dashscope_key_prefix": DASHSCOPE_API_KEY[:8] + "..." if DASHSCOPE_API_KEY else "",
    }


def main():
    args = sys.argv[1:]
    exit_on_fail = "--exit-on-fail" in args
    if exit_on_fail:
        args.remove("--exit-on-fail")

    if not args:
        status = check_key_status()
        print("Cross-Validate 跨模型交叉校验工具")
        print()
        print("API Key 状态:")
        print(f"  智谱 GLM-4-Flash:   {'已配置' if status['zhipu'] else '未配置'}")
        print(f"  通义千问 qwen-turbo: {'已配置' if status['dashscope'] else '未配置'}")
        print(f"  总状态: {'可用' if status['any_available'] else '不可用（需注册 API Key）'}")
        print()
        print("用法:")
        print("  python3 cross_validate.py <文件路径> [article|code|case_study]")
        print("  python3 cross_validate.py --text <\"内容\"> [article|code|case_study]")
        print("  python3 cross_validate.py --check")
        print("  python3 cross_validate.py <路径> code --exit-on-fail   # CI 模式")
        return

    if args[0] == "--check":
        status = check_key_status()
        print(json.dumps(status, indent=2, ensure_ascii=False))
        return

    if args[0] == "--text" and len(args) >= 2:
        content = args[1]
        content_type = args[2] if len(args) >= 3 else "article"
        result = validate_content(content, content_type)
    else:
        filepath = args[0]
        content_type = args[1] if len(args) >= 2 else "article"
        result = validate_file(filepath, content_type)

    print(json.dumps(result, indent=2, ensure_ascii=False))

    # --exit-on-fail：有 high 级别问题或 score 为 fail 时退出码 1
    if exit_on_fail:
        has_high = any(
            i.get("severity") == "high"
            for i in result.get("issues", [])
        )
        if result.get("score") == "fail" or has_high:
            sys.exit(1)


if __name__ == "__main__":
    main()
