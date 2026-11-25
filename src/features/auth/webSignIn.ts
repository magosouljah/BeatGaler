import { isCatalogClientEnabled } from "../library/catalog/catalogComposition";
import { loginBeatGalerAccount as loginSession } from "./webSession";

const prewarm = {
  enabled: isCatalogClientEnabled,
  load: () => import("../library/catalog/catalogDirectPort"),
};

export function loginBeatGalerAccount(email: string, password: string, mfaCode = "") {
  return loginSession(email, password, mfaCode, prewarm);
}
