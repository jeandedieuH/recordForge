// Forge UI — shadcn-model component kit for recordForge (spec-010).
// Named exports only; small files; subfolders per concern.

export { cn } from "./lib/cn"

// Actions
export { Button, buttonVariants, type ButtonProps } from "./components/actions/button"
export { IconButton, type IconButtonProps } from "./components/actions/icon-button"
export { ToggleGroup, ToggleGroupItem } from "./components/actions/toggle-group"

// Forms
export {
  ColorPicker,
  ColorSwatch,
  DEFAULT_COLOR_PRESETS,
  type ColorPickerProps,
  type ColorSwatchProps,
} from "./components/forms/color-picker"
export { Input, type InputProps } from "./components/forms/input"
export { Label } from "./components/forms/label"
export { NativeSelect } from "./components/forms/native-select"
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./components/forms/select"
export { Slider } from "./components/forms/slider"
export { Switch } from "./components/forms/switch"
export { Textarea, type TextareaProps } from "./components/forms/textarea"

// Nav
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/nav/tabs"

// Overlay
export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./components/overlay/alert-dialog"
export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./components/overlay/context-menu"
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "./components/overlay/dialog"
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
} from "./components/overlay/sheet"
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./components/overlay/dropdown-menu"
export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "./components/overlay/popover"
export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/overlay/tooltip"

// Feedback
export { Badge, badgeVariants, type BadgeProps } from "./components/feedback/badge"
export { EmptyState, type EmptyStateProps } from "./components/feedback/empty-state"
export {
  ErrorBoundary,
  type ErrorBoundaryProps,
  type ErrorFallbackProps,
} from "./components/feedback/error-boundary"
export {
  Progress,
  StageProgress,
  type ProgressProps,
  type StageProgressProps,
} from "./components/feedback/progress"
export { Skeleton } from "./components/feedback/skeleton"
export {
  ToastViewport,
  useToast,
  type ToastOptions,
  type ToastVariant,
} from "./components/feedback/toast"

// Display
export { AudioLevelMeter, type AudioLevelMeterProps } from "./components/display/audio-level-meter"
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/display/card"
export { Kbd } from "./components/display/kbd"
export { Separator } from "./components/display/separator"
export { Thumbnail, type ThumbnailProps } from "./components/display/thumbnail"

// Layout
export { ScrollArea, ScrollBar } from "./components/layout/scroll-area"
