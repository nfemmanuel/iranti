"""
Iranti Python Client
Memory infrastructure for multi-agent AI systems
"""

from setuptools import setup, find_packages
import os

# Read README for long description
with open("README.md", "r", encoding="utf-8") as fh:
    long_description = fh.read()

# Read version from package
version = "0.1.0"

setup(
    name="iranti",
    version=version,
    author="Niifemi Emmanuel",
    author_email="oluwaniifemi.emmanuel@uni.minerva.edu",
    description="Memory infrastructure for multi-agent AI systems",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/nfemmanuel/iranti",
    project_urls={
        "Bug Tracker": "https://github.com/nfemmanuel/iranti/issues",
        "Documentation": "https://github.com/nfemmanuel/iranti/tree/main/docs",
        "Source Code": "https://github.com/nfemmanuel/iranti",
    },
    packages=find_packages(where="clients/python"),
    package_dir={"": "clients/python"},
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "Topic :: Software Development :: Libraries :: Python Modules",
        "Topic :: Scientific/Engineering :: Artificial Intelligence",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
    ],
    python_requires=">=3.8",
    install_requires=[
        "requests>=2.25.0",
    ],
    extras_require={
        "dev": [
            "pytest>=7.0.0",
            "pytest-cov>=4.0.0",
            "black>=22.0.0",
            "flake8>=5.0.0",
            "mypy>=0.990",
        ],
    },
    keywords="ai agents memory knowledge-base multi-agent crewai langchain",
    include_package_data=True,
    zip_safe=False,
)
