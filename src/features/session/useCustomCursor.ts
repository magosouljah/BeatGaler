import { useEffect } from "react";

const CUSTOM_CURSOR_STYLE_ID = "beatgaler-custom-cursor-style";

export function useCustomCursor(enabled: boolean): void {
  useEffect(() => {
    let style = document.getElementById(CUSTOM_CURSOR_STYLE_ID) as HTMLStyleElement | null;

    if (enabled) {
      if (!style) {
        style = document.createElement("style");
        style.id = CUSTOM_CURSOR_STYLE_ID;
        style.textContent = `
          html, body, body * {
            cursor: url('/beatgaler-custom-cursor.cur'), url('/beatgaler-custom-cursor.png') 0 0, auto !important;
          }
          input[type="text"],
          input[type="email"],
          input[type="password"],
          input[type="search"],
          input[type="url"],
          input[type="tel"],
          input[type="number"],
          textarea,
          [contenteditable="true"] {
            cursor: text !important;
          }
        `;
        document.head.appendChild(style);
      }
    } else {
      style?.remove();
    }

    return () => {
      // Keep the current setting active across React re-renders.
    };
  }, [enabled]);
}
