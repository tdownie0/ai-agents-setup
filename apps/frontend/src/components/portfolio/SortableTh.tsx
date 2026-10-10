import { TableHead } from "@/components/ui/table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SortDirection } from "@/lib/useTableSort";

export function SortableTh<K extends string>({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: K;
  activeKey: K | null;
  dir: SortDirection;
  onSort: (key: K) => void;
  align?: "left" | "right";
}) {
  const active = activeKey === sortKey;
  const ariaSort: "ascending" | "descending" | "none" = active
    ? dir === "asc"
      ? "ascending"
      : "descending"
    : "none";
  return (
    <TableHead aria-sort={ariaSort} className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn("inline-flex items-center gap-1", align === "right" && "justify-end w-full")}
      >
        {label}
        {active ? (
          dir === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground/50" />
        )}
      </button>
    </TableHead>
  );
}
