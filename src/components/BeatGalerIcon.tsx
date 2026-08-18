import React from "react";

export type BeatGalerIconName = "cloud" | "box";

export default function BeatGalerIcon({
  name,
  size = 14,
  title,
}: {
  name: BeatGalerIconName;
  size?: number;
  title?: string;
}) {
  return (
    <img
      src={`/beatgaler-icons/${name}.png`}
      alt=""
      aria-hidden={title ? undefined : true}
      title={title}
      style={{
        width: size,
        height: size,
        display: "inline-block",
        objectFit: "contain",
        verticalAlign: "middle",
        flexShrink: 0,
      }}
    />
  );
}
