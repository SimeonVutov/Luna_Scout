export type Orientation = {
  latitude: number;
  longitude: number;
  northAngle: number | null;
};

function coordinateLabel(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(3)}°${value < 0 ? negative : positive}`;
}

export function MapCompass({ orientation }: { orientation: Orientation | null }) {
  const angle = orientation?.northAngle ?? null;
  const bearing = angle === null ? null : (Math.round(-angle) % 360 + 360) % 360;
  const cardinal = bearing === null ? null : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(bearing / 45) % 8];
  const centered = orientation && angle === null;
  const pole = orientation && orientation.latitude > 0 ? "North pole" : "South pole";
  const direction = bearing !== null ? `Up is ${cardinal} · ${bearing}°` : centered
    ? `${pole === "North pole" ? "South" : "North"} in all directions` : "Surface out of view";
  const coordinates = centered ? pole : orientation
    ? `${coordinateLabel(orientation.latitude, "N", "S")} · ${coordinateLabel(orientation.longitude, "E", "W")}`
    : null;
  return <div className="map-compass" aria-label={`${direction}${coordinates ? `, center ${coordinates}` : ""}`}>
    <div className="compass-rose" aria-hidden="true">
      {angle === null ? <span className="compass-cross">+</span> : ["N", "E", "S", "W"].map((label, index) => {
        const radians = (angle + index * 90) * Math.PI / 180;
        return <span key={label} className={label === "N" ? "compass-north" : undefined} style={{
          left: `${50 + 37 * Math.sin(radians)}%`,
          top: `${50 - 37 * Math.cos(radians)}%`,
        }}>{label}</span>;
      })}
    </div>
    <strong>{direction}</strong>
    {coordinates && <span title="Map center">{coordinates}</span>}
  </div>;
}
