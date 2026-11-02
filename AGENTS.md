# UI delivery requirements

Treat field alignment as an acceptance requirement for every UI change that adds or edits forms.

- Deliver aligned labels, text fields, selectors, checkboxes and adjacent action buttons in the initial change. Reuse the existing form components and shared layout patterns.
- Keep label/help, control and validation-message tracks separate. Wrapping labels, descriptions, errors or loading messages must not offset neighboring controls. Use shared grid tracks instead of per-field spacer or margin adjustments.
- Place each help icon beside the first line of its label and center it on that line. Preserve accessible names, keyboard operation and checkbox behavior.
- Match the heights and edges of controls and buttons sharing a row. Let narrow layouts stack cleanly without clipped controls or page overflow.
- Inspect the actual rendered UI for all affected options and conditional fields. Verify 375, 768, 1280 and 1440px widths and actual 200% browser zoom for responsive form changes; retain screenshots and geometry evidence. A build or typecheck alone does not establish visual alignment.
