#!/bin/bash

# Lint script for workflow-use repository
# This script runs all linters for Python and TypeScript/JavaScript code

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== Running Linters ===${NC}\n"

# Python linting
echo -e "${YELLOW}[1/6] Linting workflow Python code (Ruff)...${NC}"
cd workflows
uv run ruff check
echo -e "${GREEN}✓ Ruff linting passed${NC}\n"

echo -e "${YELLOW}[2/6] Checking workflow Python code formatting (Ruff)...${NC}"
uv run ruff format --check
echo -e "${GREEN}✓ Ruff formatting check passed${NC}\n"

# Recording linting
cd ../recording
echo -e "${YELLOW}[3/6] Linting recording Python code (Ruff)...${NC}"
uv run ruff check .
echo -e "${GREEN}✓ Recording Ruff linting passed${NC}\n"

echo -e "${YELLOW}[4/6] Checking recording Python code formatting (Ruff)...${NC}"
uv run ruff format --check .
echo -e "${GREEN}✓ Recording Ruff formatting check passed${NC}\n"

# Extension linting
echo -e "${YELLOW}[5/6] Linting Extension code (ESLint)...${NC}"
cd ../extension
npm run lint
echo -e "${GREEN}✓ Extension ESLint passed${NC}\n"

echo -e "${YELLOW}[6/6] Checking Extension TypeScript compilation...${NC}"
npm run compile
echo -e "${GREEN}✓ Extension TypeScript check passed${NC}\n"

cd ..

echo -e "${GREEN}=== All linters passed! ===${NC}"
