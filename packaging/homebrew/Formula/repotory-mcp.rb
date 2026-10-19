# Repotory MCP server (Linux)
#
# The desktop app has no Linux installer artifact (it ships as a bare tarball),
# but the MCP server is a pure Go / zero-CGO binary and installs cleanly, so the
# Formula covers MCP on Linux rather than the GUI app.
#
# Version is stamped by scripts/update-manifests.sh from wails.json
# (info.productVersion) — never edit it by hand.
class RepotoryMcp < Formula
  desc "MCP stdio server exposing the Repotory local knowledge base to AI agents"
  homepage "https://github.com/sky-jiangcheng/repotory"
  version "2.7.0"
  license "MIT"

  if OS.mac? && Hardware::CPU.arm?
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-mcp-darwin-arm64.tar.gz"
    sha256 "57d54469b6f00b4f19185b36fa2c806f60650d876e66eb49bb9eff74014cd5aa"
  elsif OS.mac? && Hardware::CPU.is_64_bit?
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-mcp-darwin-amd64.tar.gz"
    sha256 "1a20f669ec768bab10de8ae3472349848d7919ed709c2491ea1300c86e65973f"
  else
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-mcp-linux-amd64.tar.gz"
    sha256 "45d07e6ea293e5c1e5bb05051b8b5839b20b396634dd6db83df1fb3b000a87c4"
  end

  def install
    bin.install "repotory-mcp"
  end

  # The binary is a stdio MCP server: running it with no stdin makes it block
  # on the JSON-RPC loop, so it cannot be executed as a test. Assert the file
  # landed and is executable instead of pretending to run it.
  test do
    assert_path_exists bin/"repotory-mcp"
    assert_predicate bin/"repotory-mcp", :executable?
  end
end
