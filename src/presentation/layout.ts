// How the game arranges itself for a device. The decision is made from the area the player actually has — width, height
// and whether the pointer is a finger — and never from the name of the device: a phone in Split View, a tablet rotated
// and a small window on a large screen are the same problem, and a browser cannot be asked to name the machine anyway.
//
// The three levels the shell is built from: a permanent bar with the numbers a player watches, a contextual card that
// appears where the player touched, and the management screens, which are opened on purpose. Only the last of those is
// ever big, and on a phone none of them floats over the city.
export type LayoutMode = {
 // Where the primary actions live. A bottom dock is the shape a hand reaches for; a rail is for a screen with more
 // height than the gestures need, which is what a wide window is.
 dock: 'bottom' | 'rail';
 // How the management screens open: a sheet rises from the edge it belongs to, a drawer keeps the city visible beside it.
 sheets: 'sheet' | 'drawer';
 // Where what the player touched is described. A card sits near the touch; a panel is a column that stays put.
 inspector: 'card' | 'panel';
 // Whether screens may be dragged around and left where they are. Floating is a workstation habit: it is worth having on
 // a large screen and worth refusing on a phone, where a stray window is a window the player cannot get back.
 floating: boolean;
 // Whether the visual targets are sized for a finger.
 touch: boolean;
};
// A finger needs about 44 CSS pixels; a mouse is comfortable well below the 24 the accessibility guidelines call the
// floor. The two are recorded as numbers so the stylesheet and the tests can both read them.
export const TARGET_TOUCH = 44;
export const TARGET_POINTER = 28;
// The area at which a screen stops being a phone: below this, a bottom sheet that covers the city is the only shape
// that fits, and above it there is room to keep the city in view beside the screen it opened.
const NARROW = 640;
// A screen this short is a phone held sideways: there is no room for anything that takes height, whatever its width.
const SHORT = 520;
// The area at which a screen has room for a column beside the map rather than over it.
const WIDE = 1180;
// And the point where the leftover width is enough for a rail instead of a dock.
const ULTRAWIDE = 1600;

export function layoutFor(width: number, height: number, touch: boolean): LayoutMode {
 const portrait = height >= width;
 // A phone, a small window, or a phone-shaped part of a split screen: one column, sheets, nothing floating.
 if (width < NARROW || height < SHORT || (portrait && width < WIDE)) {
  return {dock: 'bottom', sheets: 'sheet', inspector: 'card', floating: false, touch};
 }
 // A screen with room to keep the city visible while a management screen is open: a drawer down one side.
 if (width < ULTRAWIDE) {
  // A screen with a finger in it never keeps a window the player can drag out of reach, however roomy it is.
  return {dock: 'bottom', sheets: 'drawer', inspector: 'panel', floating: !touch && width >= WIDE, touch};
 }
 // A wide screen wastes its edges if everything is in the middle: the actions move to a rail and the rest is city.
 return {dock: 'rail', sheets: 'drawer', inspector: 'panel', floating: !touch, touch};
}

export function targetSize(mode: LayoutMode): number {
 return mode.touch ? TARGET_TOUCH : TARGET_POINTER;
}
