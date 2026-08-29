import { useEffect } from "react";

const KEYBOARD_BOUND = "bgKeyboardBound";
const DISCLOSURE_BOUND = "bgDisclosureBound";

function text(element: Element | null): string {
  return String(element?.textContent || "").replace(/\s+/g, " ").trim();
}

function directButton(root: Element | null): HTMLButtonElement | null {
  if (!root) return null;
  return Array.from(root.children).find((child): child is HTMLButtonElement => child instanceof HTMLButtonElement) ?? null;
}

function bindKeyboardClick(element: HTMLElement): void {
  if (element.dataset[KEYBOARD_BOUND] === "true") return;
  element.dataset[KEYBOARD_BOUND] = "true";
  element.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (element.getAttribute("aria-disabled") === "true") return;
    event.stopPropagation();
    event.preventDefault();
    element.click();
  });
}

function makeButtonLike(element: HTMLElement | null, label: string): void {
  if (!element) return;
  if (!(element instanceof HTMLButtonElement)) {
    element.setAttribute("role", "button");
    if (!element.hasAttribute("tabindex")) element.tabIndex = 0;
    bindKeyboardClick(element);
  }
  element.setAttribute("aria-label", label);
}

function bindHoverDisclosure(element: HTMLElement): void {
  if (element.dataset[DISCLOSURE_BOUND] === "true") return;
  element.dataset[DISCLOSURE_BOUND] = "true";
  element.setAttribute("aria-expanded", "false");

  const open = () => {
    element.dataset.bgDisclosureOpen = "true";
    element.setAttribute("aria-expanded", "true");
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  };
  const close = () => {
    element.dataset.bgDisclosureOpen = "false";
    element.setAttribute("aria-expanded", "false");
    element.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
  };
  const toggle = () => {
    if (element.dataset.bgDisclosureOpen === "true") close();
    else open();
  };

  element.addEventListener("focus", open);
  element.addEventListener("blur", close);
  element.addEventListener("click", toggle);
  element.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.stopPropagation();
      event.preventDefault();
      toggle();
    }
  });
}

function addFoundationButton(button: HTMLButtonElement, variant: "ghost" | "danger" = "ghost"): void {
  button.classList.add("bg-button", `bg-button--${variant}`, "bg-library-compact-button");
}

function enhanceHeader(shell: HTMLElement): HTMLElement | null {
  const brand = Array.from(shell.querySelectorAll<HTMLElement>("span"))
    .find(candidate => text(candidate).toLowerCase() === "beat galer" && candidate.parentElement?.parentElement === shell);
  const header = brand?.parentElement;
  if (!header) return null;

  header.classList.add("bg-library-header");
  header.setAttribute("role", "banner");
  header.setAttribute("aria-label", "BeatGaler library header");
  brand.classList.add("bg-library-brand");

  const controls = Array.from(header.children).find((child): child is HTMLElement => child instanceof HTMLElement && child.tagName === "DIV");
  if (!controls) return header;
  controls.classList.add("bg-library-header__controls");

  const searchRoot = controls.children.item(0) instanceof HTMLElement ? controls.children.item(0) as HTMLElement : null;
  if (searchRoot) {
    searchRoot.classList.add("bg-library-search");
    const searchInput = searchRoot.querySelector<HTMLInputElement>('input[placeholder="Search beats…"]');
    const searchTrigger = searchRoot.querySelector<HTMLButtonElement>("button");
    if (searchTrigger) {
      addFoundationButton(searchTrigger);
      searchTrigger.classList.add("bg-library-search__trigger");
      searchTrigger.setAttribute("aria-label", "Search library");
      searchTrigger.setAttribute("aria-expanded", searchInput ? "true" : "false");
    }
    if (searchInput) {
      searchInput.classList.add("bg-field", "bg-library-search__input");
      searchInput.setAttribute("aria-label", "Search library");
      searchInput.setAttribute("type", "search");
      searchInput.setAttribute("inputmode", "search");
      searchInput.setAttribute("autocomplete", "off");
    }
  }

  const sortRoot = controls.children.item(1) instanceof HTMLElement ? controls.children.item(1) as HTMLElement : null;
  if (sortRoot) {
    sortRoot.classList.add("bg-library-sort");
    const trigger = directButton(sortRoot);
    const popup = Array.from(sortRoot.children).find((child): child is HTMLElement => child instanceof HTMLElement && child !== trigger);
    if (trigger) {
      const activeLabel = text(trigger) || "Sort";
      addFoundationButton(trigger);
      trigger.classList.add("bg-library-sort__trigger");
      trigger.setAttribute("aria-label", `Sort library. Current: ${activeLabel}`);
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", popup ? "true" : "false");
    }
    if (popup) {
      popup.classList.add("bg-library-sort__popup");
      popup.setAttribute("role", "listbox");
      popup.setAttribute("aria-label", "Sort library");
      const active = text(trigger);
      popup.querySelectorAll<HTMLButtonElement>("button").forEach(option => {
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", text(option) === active ? "true" : "false");
      });
    }
  }

  Array.from(controls.children).forEach(child => {
    if (!(child instanceof HTMLButtonElement)) return;
    addFoundationButton(child);
    child.classList.add("bg-library-header-action");
    const visible = text(child);
    const title = child.getAttribute("title") || "";
    if (!child.getAttribute("aria-label") && (title || visible)) child.setAttribute("aria-label", title || visible);
    if (visible === "Done") child.setAttribute("aria-label", "Finish selection");
  });

  return header;
}

function enhanceSelectionToolbar(shell: HTMLElement, header: HTMLElement | null): void {
  const toolbar = Array.from(shell.children).find((child): child is HTMLElement => {
    if (!(child instanceof HTMLElement) || child === header) return false;
    const labels = Array.from(child.querySelectorAll("button")).map(button => text(button));
    return labels.includes("Edit all") && labels.includes("Remove all");
  });
  if (!toolbar) return;

  toolbar.classList.add("bg-library-selection-toolbar");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Selection actions");
  const count = Array.from(toolbar.querySelectorAll<HTMLElement>("span")).find(node => /selected$/i.test(text(node)));
  if (count) {
    count.classList.add("bg-library-selection-count");
    count.setAttribute("aria-live", "polite");
  }
  toolbar.querySelectorAll<HTMLButtonElement>("button").forEach(button => {
    addFoundationButton(button, text(button) === "Remove all" ? "danger" : "ghost");
  });
}

function tagState(button: HTMLButtonElement): "included" | "excluded" | "idle" {
  if (button.style.textDecoration.includes("line-through")) return "excluded";
  const color = button.style.color.replace(/\s+/g, "").toLowerCase();
  if (["#fff", "#ffffff", "white", "rgb(255,255,255)", "#000", "#000000", "black", "rgb(0,0,0)"].includes(color)) {
    return "included";
  }
  return "idle";
}

function enhanceTags(scroll: HTMLElement): void {
  const candidate = scroll.previousElementSibling;
  if (!(candidate instanceof HTMLElement)) return;
  const buttons = Array.from(candidate.querySelectorAll<HTMLButtonElement>(":scope > button"));
  if (!buttons.some(button => text(button) === "All")) return;

  candidate.classList.add("bg-library-tags");
  candidate.setAttribute("role", "group");
  candidate.setAttribute("aria-label", "Tag filters");

  buttons.forEach(button => {
    button.classList.add("bg-library-tag");
    const label = text(button);
    if (label === "All") {
      const active = button.style.color.replace(/\s+/g, "").toLowerCase();
      const allActive = ["#000", "#000000", "black", "rgb(0,0,0)"].includes(active);
      button.setAttribute("aria-label", "Show all tags");
      button.setAttribute("aria-pressed", allActive ? "true" : "false");
      return;
    }
    const state = tagState(button);
    button.dataset.filterState = state;
    button.setAttribute("aria-label", `Tag ${label}: ${state}`);
    button.setAttribute("aria-pressed", state === "included" ? "true" : "false");
  });
}

function isSelectedCard(card: HTMLElement, artwork: HTMLElement): boolean {
  const selector = Array.from(card.children).find((child): child is HTMLElement => {
    if (!(child instanceof HTMLElement) || child === artwork) return false;
    return child.style.position === "absolute" && child.style.top === "6px" && child.style.left === "6px";
  });
  if (!selector) return false;
  const background = selector.style.background.replace(/\s+/g, "").toLowerCase();
  return background === "#fff" || background === "#ffffff" || background === "white" || background === "rgb(255,255,255)";
}

function enhanceCard(card: HTMLElement): boolean {
  const artwork = card.querySelector<HTMLElement>(":scope > [data-beat-artwork-id]");
  if (!artwork) return false;

  card.classList.add("bg-library-card");
  const info = artwork.nextElementSibling instanceof HTMLElement ? artwork.nextElementSibling : null;
  info?.classList.add("bg-library-card__info");

  const infoChildren = info ? Array.from(info.children).filter((child): child is HTMLElement => child instanceof HTMLElement) : [];
  const titleRow = infoChildren[0] ?? null;
  const statusRow = info?.querySelector<HTMLElement>(":scope > [data-beatgaler-status-row]") ?? null;
  const statusIndex = statusRow ? infoChildren.indexOf(statusRow) : -1;
  const tagsRow = infoChildren[statusIndex >= 0 ? statusIndex + 1 : 1] ?? null;
  const metaRow = infoChildren[statusIndex >= 0 ? statusIndex + 2 : 2] ?? null;
  titleRow?.classList.add("bg-library-card__title-row");
  statusRow?.classList.add("bg-library-card__status");
  tagsRow?.classList.add("bg-library-card__tags");
  metaRow?.classList.add("bg-library-card__meta");

  const titleControl = titleRow?.firstElementChild instanceof HTMLElement ? titleRow.firstElementChild : null;
  const beatName = text(titleControl) || `beat ${card.dataset.beatCardId || ""}`.trim();
  if (titleControl) {
    titleControl.classList.add("bg-library-card__title");
    makeButtonLike(titleControl, `Open details for ${beatName}`);
  }

  artwork.classList.add("bg-library-artwork");
  const blocked = artwork.getAttribute("aria-disabled") === "true";
  makeButtonLike(artwork, blocked ? `${beatName} playback unavailable` : `Play ${beatName}`);

  const more = Array.from(card.querySelectorAll<HTMLElement>("div")).find(node => text(node) === "···" && node.children.length === 0);
  if (more) {
    more.classList.add("bg-library-more-actions");
    makeButtonLike(more, `More actions for ${beatName}`);
    more.setAttribute("aria-haspopup", "menu");
  }

  const warning = card.querySelector<HTMLElement>('[aria-label="Why this beat is highlighted"]');
  if (warning) {
    card.classList.add("bg-library-card--warning");
    warning.classList.add("bg-library-card-disclosure");
    makeButtonLike(warning, `Project warning for ${beatName}`);
    bindHoverDisclosure(warning);
  } else {
    card.classList.remove("bg-library-card--warning");
  }

  const uploadError = card.querySelector<HTMLElement>('[aria-label="Background upload failed"]');
  if (uploadError) {
    uploadError.classList.add("bg-library-card-disclosure");
    makeButtonLike(uploadError, `Upload failed for ${beatName}`);
    bindHoverDisclosure(uploadError);
  }

  Array.from(card.querySelectorAll<HTMLElement>("div")).forEach(node => {
    if (text(node) === "HQ" && node.children.length === 0 && node.style.position === "absolute") {
      node.classList.add("bg-library-hq");
    }
  });

  const selectMode = card.style.cursor === "pointer";
  if (selectMode) {
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", isSelectedCard(card, artwork) ? "true" : "false");
    card.setAttribute("aria-label", `${beatName}${card.getAttribute("aria-selected") === "true" ? ", selected" : ", not selected"}`);
    if (!card.hasAttribute("tabindex")) card.tabIndex = 0;
    bindKeyboardClick(card);
  } else {
    card.setAttribute("role", "listitem");
    card.removeAttribute("aria-selected");
    card.removeAttribute("aria-label");
    card.removeAttribute("tabindex");
  }
  return selectMode;
}

function enhanceGrid(scroll: HTMLElement): void {
  const firstCard = scroll.querySelector<HTMLElement>("[data-beat-card-id]");
  const grid = firstCard?.parentElement;
  if (!grid) return;

  grid.classList.add("bg-library-grid");
  let selectMode = false;
  grid.querySelectorAll<HTMLElement>(":scope > [data-beat-card-id]").forEach(card => {
    selectMode = enhanceCard(card) || selectMode;
  });
  grid.setAttribute("role", selectMode ? "listbox" : "list");
  grid.setAttribute("aria-label", selectMode ? "Beat library selection" : "Beat library");
  if (selectMode) grid.setAttribute("aria-multiselectable", "true");
  else grid.removeAttribute("aria-multiselectable");
}

function enhanceMenus(): void {
  const portals = Array.from(document.body.querySelectorAll<HTMLElement>("div")).filter(node => {
    if (node.style.position !== "fixed" || Number(node.style.zIndex) !== 9999) return false;
    const labels = Array.from(node.children).map(child => text(child));
    return labels.includes("Edit metadata") || labels.includes("Edit all");
  });
  portals.forEach(menu => {
    menu.classList.add("bg-library-menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", menu.textContent?.includes("Edit all") ? "Selected beat actions" : "Beat actions");
    Array.from(menu.children).forEach(child => {
      if (!(child instanceof HTMLElement)) return;
      child.classList.add("bg-library-menu__item");
      child.setAttribute("role", "menuitem");
      child.tabIndex = 0;
      bindKeyboardClick(child);
    });
  });
}

export function enhanceLibraryDom(root: ParentNode = document): boolean {
  const scroll = root.querySelector<HTMLElement>('[data-library-scroll="true"]');
  if (!scroll) return false;

  scroll.classList.add("bg-library-scroll");
  scroll.setAttribute("role", "main");
  scroll.setAttribute("aria-label", "Beat library");

  const shell = scroll.parentElement;
  if (!shell) return false;
  shell.classList.add("bg-library-shell");
  const header = enhanceHeader(shell);
  enhanceSelectionToolbar(shell, header);
  enhanceTags(scroll);
  enhanceGrid(scroll);
  enhanceMenus();
  return true;
}

export default function LibraryUxBridge() {
  useEffect(() => {
    let frame = 0;
    const apply = () => {
      frame = 0;
      enhanceLibraryDom(document);
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(apply);
    };

    apply();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "aria-disabled"],
    });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}
