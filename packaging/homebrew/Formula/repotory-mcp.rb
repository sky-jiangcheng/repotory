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
  version "2.6.0"
  license "MIT"

  if OS.mac? && Hardware::CPU.arm?
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-mcp-darwin-arm64.tar.gz"
    sha256 "48c89bff22bd0c69ef804503541ec26403be29eaebc5be820bfebea4a4f65dd0"
  elsif OS.mac? && Hardware::CPU.is_64_bit?
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-mcp-darwin-amd64.tar.gz"
    sha256 "5596f829fa2835f5871d064e985a236a59bcc122b2778ca3ecf760d7035d509d"
  else
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-mcp-linux-amd64.tar.gz"
    sha256 "e3a6be22172de3efdc5ce3ea64c810ef496943e3f4b821829c9516ae5acf7af7"
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
