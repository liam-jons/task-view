/**
 * record-view/theme-picker.tsx — in-page theme picker (OQ-3).
 *
 * A server-rendered <select> listing the built-in themes, pre-selected to
 * the active theme. The inlined client dispatcher (apps/server/web/index.tsx
 * #wireThemePicker) hooks its `change` to write the cookie + re-class <html>
 * — no reload, reusing ThemeProvider's exact cookie keys + class grammar.
 *
 * The whole feature is the bounded add OQ-3 budgeted: this ~20-line
 * component + the ~12-line client handler + the theme-client.ts helpers.
 */
import React from "react";
import { BUILT_IN_THEMES } from "../utils/themeRegistry";

export const ThemePicker: React.FC<{ activeThemeId: string }> = ({
  activeThemeId,
}) => {
  return (
    <label className="record-view-theme-picker" data-theme-picker-label>
      <span className="sr-only">Colour theme</span>
      <select data-theme-picker defaultValue={activeThemeId} aria-label="Colour theme">
        {BUILT_IN_THEMES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
};
