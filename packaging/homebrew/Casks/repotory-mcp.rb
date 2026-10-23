# Repotory MCP server (macOS)
#
# The MCP stdio server is the AI execution interface for Repotory — the desktop
# app is not required to use it, it reads the same local SQLite database.
#
# Version is stamped by scripts/update-manifests.sh from wails.json
# (info.productVersion) — never edit it by hand.
cask "repotory-mcp" do
  version "2.12.1"
  name "Repotory MCP Server"
  desc "MCP stdio server exposing the Repotory local knowledge base to AI agents"
  homepage "https://github.com/sky-jiangcheng/repotory"
  license "MIT"

  on_arm do
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-mcp-darwin-arm64.tar.gz"
    sha256 "4801e0a7e4a03536d529e97d89bc3c898533fc0f653b3da2d428fc666a6395e1"
  end

  on_intel do
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-mcp-darwin-amd64.tar.gz"
    sha256 "3ae6cf181004b2f5aa950fcbeec478bcc075ac3b0ecfb28d260e80da7ed476c1"
  end

  # The tarball stages a single bare `repotory-mcp` at its root; `binary` links
  # it into $(brew --prefix)/bin so `which repotory-mcp` works for
  # `claude mcp add repotory -- $(which repotory-mcp)`.
  binary "repotory-mcp"
end
