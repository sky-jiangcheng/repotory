# Repotory MCP server (macOS)
#
# The MCP stdio server is the AI execution interface for Repotory — the desktop
# app is not required to use it, it reads the same local SQLite database.
#
# Version is stamped by scripts/update-manifests.sh from wails.json
# (info.productVersion) — never edit it by hand.
cask "repotory-mcp" do
  version "2.12.0"
  name "Repotory MCP Server"
  desc "MCP stdio server exposing the Repotory local knowledge base to AI agents"
  homepage "https://github.com/sky-jiangcheng/repotory"
  license "MIT"

  on_arm do
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-mcp-darwin-arm64.tar.gz"
    sha256 "8b886fb2f0f5fa8c07d92d02696c6d73c9c716dab6ec2b837bcd5341f646cdbd"
  end

  on_intel do
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-mcp-darwin-amd64.tar.gz"
    sha256 "da33845b48001c317559a069fb0d1cf3128620159b591624c48fc8b5d15d458f"
  end

  # The tarball stages a single bare `repotory-mcp` at its root; `binary` links
  # it into $(brew --prefix)/bin so `which repotory-mcp` works for
  # `claude mcp add repotory -- $(which repotory-mcp)`.
  binary "repotory-mcp"
end
