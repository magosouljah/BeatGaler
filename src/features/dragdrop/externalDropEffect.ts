export function preferredExternalDropEffect(
  effectAllowed: DataTransfer["effectAllowed"],
): DataTransfer["dropEffect"] {
  // Chromium can expose browser image/link drags as link-only. Forcing `copy`
  // when the source only allows `link` makes Windows show the prohibited cursor.
  // Pick an effect that is actually permitted by the source.
  switch (effectAllowed) {
    case "link":
    case "linkMove":
      return "link";
    case "move":
      return "move";
    case "none":
      return "none";
    default:
      return "copy";
  }
}
