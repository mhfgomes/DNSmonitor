import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

type Theme = "system" | "light" | "dark";
const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (theme: Theme) => void;
}>({ theme: "system", setTheme: () => {} });
function storedTheme(): Theme {
  try {
    const saved = localStorage.getItem("dnsmonitor-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* Storage may be disabled. */
  }
  return "system";
}
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", dark ? "#1f1a24" : "#fdf7fd");
    };
    apply();
    media.addEventListener("change", apply);
    try {
      localStorage.setItem("dnsmonitor-theme", theme);
    } catch {
      /* Theme still works without storage. */
    }
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return <ThemeContext value={{ theme, setTheme }}>{children}</ThemeContext>;
}
export function ThemeControl() {
  const { theme, setTheme } = useContext(ThemeContext);
  return (
    <div
      role="group"
      aria-label="Color theme"
      className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1"
    >
      {(
        [
          { value: "light", Icon: Sun },
          { value: "dark", Icon: Moon },
          { value: "system", Icon: Monitor },
        ] as const
      ).map(({ value, Icon }) => (
        <Button
          key={value}
          variant="ghost"
          size="icon-sm"
          aria-label={`${value[0]!.toUpperCase()}${value.slice(1)} theme`}
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
          className={
            theme === value
              ? "bg-highlight text-foreground"
              : "text-muted-foreground"
          }
        >
          <Icon size={15} />
        </Button>
      ))}
    </div>
  );
}
