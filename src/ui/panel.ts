import type { Config } from "../core/config";

export type CtrlKind = "range" | "number" | "bool" | "select";

export interface Ctrl {
  path: string;
  label: string;
  kind: CtrlKind;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: [string, string][];
  /** A change here needs the model rebuilt and restarted. */
  rebuild?: boolean;
  hint?: string;
  /** Only show the control when this predicate passes. */
  when?: (cfg: Config) => boolean;
  /** Other config paths that receive the same value (e.g. dy following dx). */
  mirror?: string[];
}

export interface Group {
  title: string;
  open?: boolean;
  items: Ctrl[];
}

function getPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}

function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const target = keys.reduce<unknown>(
    (o, k) => (o as Record<string, unknown>)[k],
    obj
  ) as Record<string, unknown>;
  target[last] = value;
}

/** Schema-driven control panel: every field of Config is editable by hand. */
export class Panel {
  private refreshers: (() => void)[] = [];
  private visibility: { el: HTMLElement; when: (c: Config) => boolean }[] = [];

  constructor(
    private root: HTMLElement,
    private cfg: Config,
    private groups: Group[],
    private onChange: (rebuild: boolean) => void
  ) {
    this.build();
  }

  private build(): void {
    this.root.innerHTML = "";
    for (const g of this.groups) {
      const det = document.createElement("details");
      det.className = "group";
      if (g.open) det.open = true;
      const sum = document.createElement("summary");
      sum.textContent = g.title;
      det.appendChild(sum);
      for (const c of g.items) det.appendChild(this.control(c));
      this.root.appendChild(det);
    }
    this.refresh();
  }

  private control(c: Ctrl): HTMLElement {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("label");
    label.textContent = c.label + (c.unit ? ` (${c.unit})` : "");
    if (c.hint) label.title = c.hint;
    row.appendChild(label);
    if (c.when) this.visibility.push({ el: row, when: c.when });

    const commit = (v: unknown) => {
      setPath(this.cfg, c.path, v);
      for (const m of c.mirror ?? []) setPath(this.cfg, m, v);
      this.updateVisibility();
      this.onChange(!!c.rebuild);
    };

    if (c.kind === "bool") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.addEventListener("change", () => commit(input.checked));
      row.appendChild(input);
      this.refreshers.push(() => {
        input.checked = Boolean(getPath(this.cfg, c.path));
      });
    } else if (c.kind === "select") {
      const sel = document.createElement("select");
      for (const [value, text] of c.options ?? []) {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = text;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => commit(sel.value));
      row.appendChild(sel);
      this.refreshers.push(() => {
        sel.value = String(getPath(this.cfg, c.path));
      });
    } else {
      const wrap = document.createElement("div");
      wrap.className = "numwrap";
      const num = document.createElement("input");
      num.type = "number";
      num.className = "num";
      if (c.min !== undefined) num.min = String(c.min);
      if (c.max !== undefined) num.max = String(c.max);
      if (c.step !== undefined) num.step = String(c.step);
      let slider: HTMLInputElement | null = null;
      if (c.kind === "range") {
        slider = document.createElement("input");
        slider.type = "range";
        slider.min = String(c.min ?? 0);
        slider.max = String(c.max ?? 1);
        slider.step = String(c.step ?? 0.01);
        slider.addEventListener("input", () => {
          num.value = slider!.value;
          commit(Number(slider!.value));
        });
        wrap.appendChild(slider);
      }
      num.addEventListener("change", () => {
        let v = Number(num.value);
        if (c.min !== undefined) v = Math.max(v, c.min);
        if (c.max !== undefined) v = Math.min(v, c.max);
        num.value = String(v);
        if (slider) slider.value = String(v);
        commit(v);
      });
      wrap.appendChild(num);
      row.appendChild(wrap);
      this.refreshers.push(() => {
        const v = Number(getPath(this.cfg, c.path));
        num.value = String(v);
        if (slider) slider.value = String(v);
      });
    }
    return row;
  }

  private updateVisibility(): void {
    for (const v of this.visibility)
      v.el.style.display = v.when(this.cfg) ? "" : "none";
  }

  /** Pull every control's value back from the config object. */
  refresh(): void {
    for (const r of this.refreshers) r();
    this.updateVisibility();
  }
}
