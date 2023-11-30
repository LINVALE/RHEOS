
# RHEOS


A ROON Extension to allow  control of Denon/Marantz HEOS devices from ROON.

## Features

-   🔎 Automatic discovery of HEOS devices and make them available as ROON audio devices (via UPnP).
-   🎯 Bi-directional Control of player play, pause, previous, volume, mute and grouping within HEOS players from ROON or Heos App.
-   🎶 Group HEOS devices from ROON. Uses HEOS grouping to ensure synchronization with other HEOS players. Only groups HEOS players.
-   🔗 Create fixed groups for ROON outputs. Allows volume  control of all grouped players from ROON interface using single control.
-   ⇆  Control Denon/Marantz Amplifier Zone power, volumes and select sound modes.
-   🔊 Does not use AirPlay so can stream at Hi-Resolution for HS2 players.
-   🚫 Written in pure Javascript / Nodejs with limited module dependencies (heos-api, squeeze2UPnP, Xml2js,ip)


## Installation

Install/Update nodejs for your system (tested on Windows, Ubuntu 22.04.1 LTS, and Raspberry pi 4) . This requires at least Node v16.0. [https://nodejs.org/en/download/]

The simplest way to install this is using the roon-extension-manager https://github.com/TheAppgineer/roon-extension-manager 
Tested with a raspberry pi3 (Ubuntu 32 bit), pi 4(3Ubuntu 2 and 64bit) and NUC (Ubuntu 22.04.1 LTS amd64)

Next option is to install docker and pull a copy from my repo : https://hub.docker.com/repository/docker/rheos/roon-extension-rheos

If you want to run and use a local configuraion file (so that settings are saved between updates) run with -v option. 

To manually install (e.g. if you want to run on a Windows box) this works :-

Clone a local copy of this repository to a local directory './RHEOS', or copy the zip file and unpack into './RHEOS'.

From the command line try : “gh repo clone LINVALE/RHEOS ./RHEOS”

(If successful you will see a ‘package.json’ and ‘package-lock.json’ as well as ‘app.mjs’ in the directory, along with other required files)

Then switch to that directory and type “npm install”, This should create a folder ‘node_modules’ with the required dependencies.


To install rheos using `npm`: 

```
npm install rheos 
```

## Initial Set Up

Run the app from the directory to which you downloaded on the command line type  -> "node ."

Enable Squeezebox Support via Setup -> Enable squeezebox support

Enable RHEOS in ROON via Settings -> Extensions -> enable


### Connecting to devices

RHEOS will attempt to discover all connected HEOS devices on start up. Tested to date with Marantz HEOS enabled AVRs, PLAYERS :HEOS DRIVE HS1 and HS2, HEOS1, HEOS3, HEOS 5 and HEOS 7, HEOS LINK and HEOS AMP. Maximum number of players that can be simulatnaeosly grouped is 16, dependent upon network performance.

Players will appear as Squeezebox Devices in ROON Settings -> Audio. Each device is intially unamed and to enable in ROON edit a device name(Edit Rooms -> Select / Edit Name).  If they do not appear make sure you are not running Logitech Media Server (LMS) and do not have another version of RHEOS enabled onthe system.

If you have HS2 or "Denon Home" devices you may wish to enable Hi-Res streaming (192 kHz 24 Bit Flac). Do this in Settings-> Extension -> RHEOS -> Settings for each HS2 player. This may increase network load and success will depend upon wired connections and a fast ethernet. All players default to CD quality 48kHz 24 bit.

Other settings include an IP address of the Heos Player you would like to use as the main connection. All HEOS commands are sent through this and RHEOS listens for changes to any of your players through this. If there is a problem discovering your HEOS players you can try to edit this address. Heos devices must by on the same local network as the Roon Serverand the device running the Rheos app.  Once a connection has been made, all HEOS player IPs are stored and can be selected from the drop-down. If none has been found you may enter the IP address, if you can find this from your router DHCP table.

Roon Extension Host IP Address shows the discovered IP address of the device you are using to run RHEOS. You may want to try editing this if for some reason network discovery is not working.

Under RHEOS UPnP Settings there are options to select buffer-size, output-size, stream-length, seek-after-pause, volume-on-play, volume-feedback, FLAC-header, keep-alive, next-delay, send-meta-data and send-cover-art. The defaults are the settings I have found to work best across a variety of HEOS players so I recoomend not adjusting these unless you have specific needs or something isn't working for you. Full information on them can be found here https://github.com/philippe44/LMS-to-uPnP. I may add or remove options in the future and change the 'default setting based upon future testing and feedback. I will note this in any updates. Metadata (now playing content and album art) does not fuction and the Heos app will not display album art or track info whilst playing from ROON.

### Usage

The HEOS players can be controlled as a normal ROON endpoint. Grouping is done through standard ROON grouping but behind the scenes these are translated to HEOS groups and you will see the change appear in the HEOS app.

A **fixed group** is a feature found in other interfaces but not normally with ROON or HEOS. It allows a pre-specified group to be automatically formed when the fixed group is selected and played. Players ungroup when play is stopped. Individual volume levels and mute for each player can be controlled from ROON and volume and mute adjusted for all players at the same time. A fixed group can be configured as Hi Res 192kHz 24 bit or CD Res 48kHz 16 bit. If a player with lower resolution is in the group is included then the entire group will play at the lower resolution.

To create a group, select the outputs/players you wish to group in the ROON interface or using the HEOS app if you prefer. Once grouped this can be converted to a fixed group in ROON by opening Settings->Extensions->RHEOS->Settings->Groups. The group will be shown with a dropdown selection for Hi Res Fixed Group, CD Res, or Delete. Selecting Hi Res or CD and saving will create a new Virtual Squeezebox Player named after the selected group. Selecting Delete will remove a previously fixed group

Once created (only for the first time) go to Settings->Audio and a new Squeezebox should be there waiting to be Enabled. The name to be displayed in ROON should be entered to something that describes the group. Insert a Unicode symbol such as :link: or :house: or :notes: as the first word - so fixed groups are easily identified and always are at the top of the list of available zones to play in ROON. The group will persist in ROON if enabled as an audio endpoint and can be recreated by grouping the same players - irrespective of their order of entry.

Once you have enabled the player, use it as normal, selecting play or pause, skip or skip back. On play, the group will automatically form (the name will then be show as the first device in the group + number of players) and it will ungroup when stopped. When the volume control for the group is selected, all player volumes are shown as in a normal group but in addition, the fixed group player will appear at the end of the list (identified by the name you choose and any inserted characters). This will control all of the player volumes in the group as well as mute or unmute all.

Fixed groups are not bi-directional and can not be constructed or controlled from the HEOS app.

**Denon/Marantz AVRs** with two zones can have their power state and volumes controlled independently. In addtion the "sound mode" of the AVR can be selected and maim power turned off.
To enable control of AVR zones go to Settings->Extensions->RHEOS->Settings->Enable AVR Zone Control and select "On". Receivers with mutiple zones will be discovered and a "Zone Control Device " created as a Squeezeplayer.To use this, the control has to be applied to the main AVR. So, select the AVR volume control and the "cog" control button.This will bring up The "zone settings" where you set up the new zones in "Device Setup". Go to "External Source Controls" and add the appropriate Main Zone and Zone 2 control from the drop down menu and also the "Sound control" for the receiver. You can change the volume control from device to the volume control called "Rheos :" and the name of your receiver. Once created switch on the AVR using the souce control that is now attached to the main receiver (click on the main power button to display the device controls) or turn on both zones manually (only for the first time). Then go to Settings->Audio and a new Squeezebox player for each zone should be there waiting to be enabled that is identified as having your receiver name and Main Zone or Zone 2. You can rename this to your preferred identifier for the zone. 

HEOS enabled AVRS and CD/Network players that can power on and off will power on when a selected RHEOS player is played and can be turned off using the power control button in the roon controller. Unfortunately I can't chane the color of the button to reflect present status due to limitations in the API.



### Known Limitations



Pausing a device from Roon and then re-starting from HEOS will result in an error message (in HEOS) and returning to the start of the track.

Skipping to next track in ROON playlist is not possible from HEOS.

Devices will show "Streaming from LMS" on their display and in the HEOS app.

Cover art and metadata are not shown on the HEOS app or on the playback device.

Windows firewalls can cause some issues. If a HEOS device is found and selected but doesnt play even a when CD resolution is selected take a look at the firewall. Allow two specific executable files to be passed throu ./ROON/UPnP/Bin/RHEOS2UPnP and ./ROON/UPnP/Bin/Squeezelite/



#### Please report any issues via GitHub or raise on the ROON communuty site.

Enjoy!



### Acknowledgements

Thanks to Juliuscc for the development of heos-api - a superb tool!

Learn more about using heos-api at:

-   [The GitHub page](https://github.com/juliuscc/heos-api)
-   [HEOS CLI Protocol Specification](http://rn.dmglobal.com/euheos/HEOS_CLI_ProtocolSpecification.pdf)


Thanks to philippe44 for development of Squeeze2UPnP. None of this would have been possible without the C binaries that allow HEOS players to emulate SlimDevices

-   [Squeeze2UPnP](https://github.com/philippe44/LMS-to-uPnP)


## Contributing

Please send issues and pull requests with your problems or ideas!
