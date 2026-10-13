import React, { useEffect, useState } from "react";
import { getExperiments } from "./resultsApi";

export function RunHistoryPage() {
  const [experiments, setExperiments] = useState([]);
  const [error, setError] = useState();
  useEffect(() => {
    void getExperiments()
      .then((value) => setExperiments(value.experiments ?? []))
      .catch((reason) => setError(reason.message));
  }, []);
  return (
    <main>
      <nav>
        <a href="#experiments">New experiment</a>
      </nav>
      <h1>Run history</h1>
      {error && <p role="alert">{error}</p>}
      {!experiments.length && !error && <p>No experiments have been submitted.</p>}
      <ul>
        {experiments.map((experiment) => (
          <li key={experiment.id}>
            <a href={`#results/${experiment.id}`}>{experiment.id}</a> — {experiment.status}
          </li>
        ))}
      </ul>
    </main>
  );
}
