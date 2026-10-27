# Repotory desktop app (macOS)
#
# Version is stamped by scripts/update-manifests.sh from wails.json
# (info.productVersion) — never edit it by hand.
#
# sha256 must be filled after each release is published; Homebrew hard-fails on
# a mismatch, which is exactly what we want from a placeholder.
cask "repotory" do
  version "2.16.0"
  name "Repotory"
  desc "Local-first code project context base"
  homepage "https://github.com/sky-jiangcheng/repotory"
  # NOTE: no `license` stanza — `license` is a FORMULA method, not a Cask
  # one. `brew install --cask` rejects the whole definition with
  # "undefined method 'license' for Cask". The license is MIT; see README.

  on_arm do
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-darwin-arm64.dmg"
    sha256 "315b7a5750e2f3a4eff49aacc6bc963621a99b2130b15629cc3448f1105e5389"
  end

  on_intel do
    url "https://github.com/sky-jiangcheng/repotory/releases/download/v#{version}/repotory-darwin-amd64.dmg"
    sha256 "e3c242bcfee3b4d40bb32148258f1dce63c2bb57bb3b9f52d181a96e486dbdb7"
  end

  # The bundle inside the DMG is named after wails.json's `outputfilename`
  # ("repotory"), NOT after the productName ("Repotory"): the build produces
  # build/bin/repotory.app and create-dmg ships that bundle as-is. macOS
  # volumes are case-insensitive by default so the old spelling resolved
  # anyway, but a case-sensitive volume would not find it — and the tap's
  # tests.yml asserts the installed path, so the two must agree exactly.
  app "repotory.app"

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
