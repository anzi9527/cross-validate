from setuptools import setup, find_packages

setup(
    name="cross-validate",
    version="0.1.0",
    description="Cross-model validation tool — AI-powered content & code reviewer using free Chinese LLM APIs",
    long_description=open("README.md", encoding="utf-8").read(),
    long_description_content_type="text/markdown",
    author="anzi9527",
    url="https://github.com/anzi9527/cross-validate",
    license="MIT",
    packages=find_packages(),
    py_modules=["cross_validate"],
    python_requires=">=3.9",
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
    ],
    entry_points={
        "console_scripts": [
            "cross-validate=cross_validate:main",
        ],
    },
)
