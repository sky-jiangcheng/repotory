# Repotory MCP server (macOS)
#
# The MCP stdio server is the AI execution interface for Repotory — the desktop
# app is not required to use it, it reads the same local SQLite database.
#
# Version is stamped by scripts/update-manifests.sh from wails.json
# (info.productVersion) — never edit it by hand.
cask "repotory-mcp" do
  version "2.11.0"
  name "Repotory MCP Server"
  desc "MCP stdio server exposing the Repotory local knowledge base to AI agents"
  homepage "https://github.com/sky-jiangcheng/repotory"
  license "MIT"

  on_arm do
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-mcp-darwin-arm64.tar.gz"
    sha256 "6eddc25d11620add2e4ee9820a63014ed3944592bc9d93cf9591f2c61ccb7c8f"
  end

  on_intel do
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-mcp-darwin-amd64.tar.gz"
    sha256 "b44d65d7031edb353de7b416318a61c078cda6398ac7cf7f343a48520b0ce43d"
  end

  # The tarball stages a single bare `repotory-mcp` at its root; `binary` links
  # it into $(brew --prefix)/bin so `which repotory-mcp` works for
  # `claude mcp add repotory -- $(which repotory-mcp)`.
  binary "repotory-mcp"
end
