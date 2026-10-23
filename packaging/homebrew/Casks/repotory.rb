# Repotory desktop app (macOS)
#
# Version is stamped by scripts/update-manifests.sh from wails.json
# (info.productVersion) — never edit it by hand.
#
# sha256 must be filled after each release is published; Homebrew hard-fails on
# a mismatch, which is exactly what we want from a placeholder.
cask "repotory" do
  version "2.12.2"
  name "Repotory"
  desc "Local-first code project context base"
  homepage "https://github.com/sky-jiangcheng/repotory"
  license "MIT"

  on_arm do
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-darwin-arm64.dmg"
    sha256 "5d60e914cad03b93ffbdd573a0c1f35e93dd0a631f861222007fc1345bb4c68d"
  end

  on_intel do
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-darwin-amd64.dmg"
    sha256 "84e4b8a0cb1a0630b8be4a8a4808a4fdbc109c8d434f3d3e7c3c61e4a6775af4"
  end

  app "Repotory.app"

  # Application Support and Logs paths come from internal/platform; they are
  # where GetDbPath() and GetLogPath() point on macOS. A bundle-identifier
  # preference is deliberately not listed here: wails.json does not set one, so
  # listing a guess would send `brew uninstall --zap` at a file that may not
  # exist. Add it only once the identifier is pinned in wails.json.
  zap trash: [
    "~/Library/Application Support/repotory",
    "~/Library/Logs/repotory.log",
  ]
end
