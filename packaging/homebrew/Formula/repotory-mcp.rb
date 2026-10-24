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
  version "2.13.1"
  license "MIT"

  if OS.mac? && Hardware::CPU.arm?
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-mcp-darwin-arm64.tar.gz"
    sha256 "47336946a365e1e8b8d615c2eb1a84b38beeb47ba108f9eb7f6db74d54ff9cad"
  elsif OS.mac? && Hardware::CPU.is_64_bit?
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-mcp-darwin-amd64.tar.gz"
    sha256 "bde793930767e6b78f9ffe0f0dce2960bc405e969e598a8b05cad52877332ec4"
  else
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-mcp-linux-amd64.tar.gz"
    sha256 "b0de7074da6e6e03665f2680b236de1f15a01fd02800f29db69edf15a2084af4"
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
