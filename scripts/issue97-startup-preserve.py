from pathlib import Path

path = Path("src/App.tsx")
text = path.read_text(encoding="utf-8")
old = '''      } catch (error) {
        console.warn("Telegram vault startup check failed:", error);
        if (!cancelled) {
          setSetupDone(true);
          setLoading(false);
          await showOfflineLibrary(
            typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor"
          );
          dismissBeatGalerStartupLoader();
        }
      }
'''
new = '''      } catch (error) {
        console.warn("Telegram vault startup check failed:", error);
        if (!cancelled) {
          setSetupDone(true);
          setLoading(false);
          setCloudSessionVerified(false);
          if (typeof navigator !== "undefined" && navigator.onLine === false) {
            await showOfflineLibrary("offline");
          } else {
            // Authority is temporarily unknown, not empty. Keep the verified/cache
            // presentation already on screen, but make it read-only until a later
            // authoritative reload succeeds. This prevents 60 -> 0 -> 60 flashes.
            setConnectionState("poor");
            dismissBeatGalerStartupLoader();
          }
        }
      }
'''
if text.count(old) != 1:
    raise SystemExit(f"expected one startup authority catch, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
