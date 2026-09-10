import AccountGate from "../components/AccountGate";
import { platform } from "../platform";
import AppShell from "./AppShell";
import { useBeatGalerComposition } from "./useBeatGalerComposition";

function BeatGalerWorkspace() {
  const scope = useBeatGalerComposition();
  return <AppShell scope={scope} />;
}

export default function BeatGalerApp() {
  return platform.kind === "web"
    ? <BeatGalerWorkspace />
    : <AccountGate><BeatGalerWorkspace /></AccountGate>;
}
