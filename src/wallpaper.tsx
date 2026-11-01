import ReactDOM from "react-dom/client";
import WallpaperApp from "./ui/WallpaperApp";
import "./styles/global.css";

document.documentElement.dataset.wallpaper = "1";

ReactDOM.createRoot(document.getElementById("root")!).render(<WallpaperApp />);
