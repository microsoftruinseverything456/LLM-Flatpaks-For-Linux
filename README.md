Three basic unofficial flatpak web apps for Claude, ChatGPT, and Grok. Designed to work with a copilot key in a manner reflective of the design of windows. However, the key must be mapped manually via OS settings. More info at the bottom.

These apps have extremely locked down permissions and an in-built firewall restricted solely to necessary sites. Third party sign ins (i.e. google, microsoft, etc.) are not supported due to the focus on preventing external analytics and tracking. Attached pictures from web searches (most common with Grok) also will not load. Adjustments via FlatSeal (or manually) can enable features like sound, microphone (also sound, usually PulseAudio or PipeWire), and file system access (drag and drop).

To install FlatSeal for permission adjustments, run "flatpak install flathub com.github.tchx84.Flatseal" without quotes, or find it in the Gnome Software app if applicable.

Scripts included for installations, removals, and updates.

This is not (yet) available on Flathub. I'm still somewhat new to the Linux scene, and haven't gotten around to registering these with Gnome.
  
  
  
  
  
  
To map one of these to a copilot key or similar AI keyboard shortcut, add one of the following to the command line for the keyboard shortcut in your OS settings:

Claude:  

/usr/bin/flatpak run --branch=master --arch=x86_64 --command=electron-wrapper --file-forwarding io.github.microsoftruinseverything456.claude @@u %U @@

ChatGPT:  

/usr/bin/flatpak run --branch=master --arch=x86_64 --command=electron-wrapper --file-forwarding io.github.microsoftruinseverything456.chatgpt @@u %U @@

Grok:  

/usr/bin/flatpak run --branch=master --arch=x86_64 --command=electron-wrapper --file-forwarding io.github.microsoftruinseverything456.grok @@u %U @@
