# Cross-Validate 示例：与写作流水线集成

本示例展示如何将 cross-validate 嵌入自动写作流水线。

## 方法一：命令行集成

```bash
#!/bin/bash
# 写入 → 审核 → 判断是否可用

# 1. 生成文章（假设由 AI 完成）
cat > output/article.md << 'EOF'
# Python 异步编程入门

本文介绍 Python asyncio 的基本用法...
EOF

# 2. 审核
python3 cross_validate.py output/article.md article > review.json

# 3. 检查结果
SCORE=$(python3 -c "import json; d=json.load(open('review.json')); print(d['score'])")
if [ "$SCORE" = "fail" ]; then
    echo "文章未通过审核，需要修改"
    exit 1
elif [ "$SCORE" = "warn" ]; then
    echo "文章通过但有警告"
fi
```

## 方法二：Python API 集成

```python
from cross_validate import validate_content, validate_file

def generate_and_validate(topic: str) -> dict:
    """生成文章并自动审核"""
    # 此处假设已有 generate_article() 函数
    article = generate_article(topic)

    # 审核
    result = validate_content(article, content_type="article")

    if result.get("score") == "fail":
        return {"status": "rejected", "issues": result.get("issues", [])}
    elif result.get("score") == "warn":
        return {"status": "flagged", "issues": result.get("issues", [])}
    else:
        return {"status": "approved"}

# 使用
result = generate_and_validate("Python 异步编程")
print(result["status"])
```

## 方法三：CI 流水线集成

```yaml
# .github/workflows/review.yml
name: Cross-Validate
on: [pull_request]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - name: Cross-validate changed files
        run: |
          pip install cross-validate
          for file in $(git diff --name-only HEAD~1); do
            case "$file" in
              *.py)   cross-validate "$file" code --exit-on-fail ;;
              *.md)   cross-validate "$file" article ;;
            esac
          done
        env:
          ZHIPU_API_KEY: ${{ secrets.ZHIPU_API_KEY }}
```

## 注意事项

1. 需先配置 `ZHIPU_API_KEY` 环境变量
2. 内容超过 3000 字会被截断，只审核前 3000 字
3. `--exit-on-fail` 在有 high 级别问题时退出码为 1
