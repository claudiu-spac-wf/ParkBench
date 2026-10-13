import React, { useEffect, useState } from "react";
import { api } from "../../api";
export function ScenarioCatalogPage() {
  const [scenarios, setScenarios] = useState([]);
  useEffect(() => {
    void api("/scenarios")
      .then((value: any) => setScenarios(value.scenarios ?? []))
      .catch(() => undefined);
  }, []);
  return (
    <main>
      <h1>Scenario catalog</h1>
      <ul>
        {scenarios.map((scenario) => (
          <li key={`${scenario.id}@${scenario.version}`}>
            {scenario.name} ({scenario.id}@{scenario.version}) — {scenario.status ?? "available"}
          </li>
        ))}
      </ul>
    </main>
  );
}
