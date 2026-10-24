# Repotory desktop app (macOS)
#
# Version is stamped by scripts/update-manifests.sh from wails.json
# (info.productVersion) — never edit it by hand.
#
# sha256 must be filled after each release is published; Homebrew hard-fails on
# a mismatch, which is exactly what we want from a placeholder.
cask "repotory" do
  version "2.13.1"
  name "Repotory"
  desc "Local-first code project context base"
  homepage "https://github.com/sky-jiangcheng/repotory"
  license "MIT"

  on_arm do
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-darwin-arm64.dmg"
    sha256 "67587f1b7e953a270be0421b1d0e0b8e61e53c51c6239c8f2628f3d014006a40"
  end

  on_intel do
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-darwin-amd64.dmg"
    sha256 "de6dbc8e114f59c7219cd046aabaff1d5dd5c4a2c45c81cd3fc712453dfb6d6c"
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
