

##

**Prompt Structure**

I will include all the prompts in here, in numeric order. Just go to the most recent prompt and take that one into consideration. For each prompt, first create a markdown plan detailing the following:
- Current state of the project
- The current problem you are trying to solve
- The steps you will take to solve the problem

The 'problems' include anything from UI changes to backend, 3D-triangulation code.


##
# Prompts

## Prompt 1
I just moved my project from `/root/vast/joshua/vibes/mv-gui` to here. But, the UI code from this repository is outdated. Read over PROJECT.md, it includes the state of the project in the mentioned path. I want you to update the UI based on the information in PROJECT.md and the code in `/root/vast/joshua/vibes/mv-gui`. For non-UI topics, ff the state of the current project is different than that of PROJECT.md, I want you to update PROJECT.md


You can read any files in `/root/vast/joshua/vibes/mv-gui` and edit any files in this respository. 


## Prompt 2
Sorry, please put all these changes in a separate branch called `josh-edits`. Then, revert main back into its normal state. Also, the demo files aren't in this repository, so it can't be loaded in the website. Please save them in the appropriate folder and names in this repository. The videos can be found here: `/root/vast/joshua/vibes/mv-gui/sample_session`


## Prompt 3
Okay, I can load the demo videos, which is good. From now on, I will refer to viewing window as ViewWin. The ViewWin should be empty when videos or SLP files are loaded.

So, when the user clicks on 'Load Demo', there should not be any videos loaded in ViewWin. If there are videos loaded in the left bar, the empty ViewWin should say 'Drag and Drop videos'.

Remove the feature where double clicking on the video unzooms it. Instead, I want blue text to pop-up on the top right corner of the video that says 'Zoomed'. When the user's cursor hovers over the text, it says 'Unzoom', and clicking on it unzooms the window. This feature is implemented in `/root/vast/joshua/vibes/mv-gui`, please look through the files there for a reference,

There is currently a bug where dragged and dropped videos are not being rendered in ViewWin. Please render dragged and dropped videos.

## 

# Prompt 4

Currently, the project can load SLP files. I want to stream line this process. Make a new option in File --> 'Load Session Folder'. Clicking on the button will allow the user to select a **folder**. The folder should have this layout:
```
folder/
├── calibration.toml
├── videos/
│   ├── *.mp4 [or any other video format]
└── slp/
    ├── *.slp
```
For each slp loaded, automatically load in the corresponding video in the `videos` folder. The names of the files should be identical except for their file extension. If there is no calibration.toml, allow the user to pass it in separately later. For any SLP files that do not have matching `mp4` (or any other video format) files, put them in a list. Then, show a pop-up table that mentions the SLP files that do not have corresponding videos and allow the user to select a video for each SLP file. Once the user selects a video for each SLP file, proceed back to the website

## 

# Prompt 5

I uploaded my a sessions folder with the correct file layout, but no SLP or video files got loaded into the editor. This is the error shown in the console:

```
global.js:1 GET api/browser_extension/user response: {"error":{"errors":["Invalid Authorization"]},"isKamiApiSuccessfulResponse":false}
(anonymous) @ global.js:1Understand this error

global.js:1 Error fetching user data for Floating K visibility: Error: unexpected_response
    at global.js:1:6092
    at async ge (global.js:1:6833)
    at async _e (global.js:1:8117)
    at async Promise.all (:8090/index 0)
```

Please allow folders to be uploaded

##

# Prompt 6

There is a bug in the timeline-contrainer where moving the timeline-cursor causes the video start playing. Moving the timeline-cursor should immediately pause the video.

Visual UI Changes

- Add a slight yellow highlight over the currently selected video.
- A video's *thumbnail* is the video icon displayed on the viewbar. Change each thumbail to have the first frame of its corresponding video, but keep the size of the icon the same
- If a video is already loaded into the video dock, then clicking **once** on the thumbnail will cause the video to be selected on the video dock. If multiple instances are already on the dock, then just select any one of the instances
- If the video is not loaded on the dock, then **double clicking** on its thumbnail will open and select the video next to the currently selected video. Note that this double click feature is currently working, but I want this to only work for videos that are not already loaded in the dock


Interaction Changes
- After uploading the SLP files, I could not click or move around the pose estimations. I can create and delete instances, but the instance that are already defined from the SLP files are not interactable. Please load the pose estimations from SLP files as instances editable by the user

##

# Prompt 7

**I am going to make some UI changes**

- There are some ViewWin UI bugs. First, when I have multiple windows of the same camera view, the zooming feature is impaired. To fix this, do not allow multiple instances of a video to be shown on the screen. Make sure the zooming feauture is not affected
- I want the highlight feature to go around the border of each video rather than the window itself.

- Make the right panel disappear when I click on `Hide Panel`
- Add a button that can collapse the timeline
- Now, when you load a project or multiple videos, I want you to display them all in a grid. Do **not** hard code any grid. I want you to use the current framework, but initialize the videos in a way that is convenint for the user. You can think of the best way to display them. For instance, if there are 4 videos they should be in a 2x2 grid. If there are 6 videos, they should be in a 2x3 grid. if there are 7 videos, there should be 4 in the top row and 3 on the bottom row. For 8 rows, they should be aligned in a 2x4 grid.


## 

# Prompt 8

* When load a project and the videos are shown on the video viewer, there is already a triangulation shown on the 3D viewer. I am confused about why triangulation is calculated pre-emptively. In your plans markdown file, I want you to explain this bug in detail. Do **not** run triangulation before identity assignment or before the user runs triangulation themselves.

* Convert the `Assign` button to a drop down menu. Include the options 'Automatic' and 'Manual'. The functionality of the 'manual' option should be what is currently the assign button. 
* For the `Automatic` option in `Assign`, first display a toast (pop up message ) that says "Select the views for automatic Identity Assignment". Make this message persist with the buttons 'Cancel' or 'Continue'. Temporarily remove the yellow highlight around the currently selected border. Now, allow the user to select or deselect each window for identity assignment. Selected windows will be highlighted in red. When the user presses the `continue` button, run Epipolar matching and the Hungarian algorithm to run automatic identity assignment for the selected views. If no views are selected, then let the user know they they did not select any views and automatic assignment was not run.
* Once automatic assignment is run, color the labels for each animal of the same identity with the same color


##

# Prompt 9

Some UI changes:

- Set the default node size to 1
- Create a new side bar for the label size, and allow the label size to be independent of node size
- When the user collapses or extends the info panel, re-render the 3D visualizer so that it is centered in the new window size
- When a user selects a window (**not** during identity automatic assignment), highlight the camera in the 3D viewer.

- The assign button isn't on the main screen; please add it next to the `Create Group` button


##

# Prompt 10

I still don't see the `Assign` drop down menu on the screen. Currently the UI layout looks like
```
│ +Inst -Inst │ CreateGroup Unlink│ Triangulate Triangulate All│ NodeSize Label │ │ ☐Detected ☐Reproj ☐Errors ☐Labels           [Hide Panel] (Toolbar)│
```

Please have the `Assign` drop down menu next to the `CreateGroup` button


## 

# Prompt 11

Now, I can see the `Assign` drop down menu, but both `manual` or `automatic` buttons don't do anything. Let's first focus on the `automatic` button. Remember that when the user clicks on the `automatic` button, a persistent toast widget should appear on the screen. The toast widget should read 'please choose the views for automatic assignment' with two buttons, `Cancel` and `Continue`. The user should be able to toggle each view yes/no, indicated by their highlight in red (yes) or no highlight (no). Then, if the user presses `Continue`, then epipolar geometry and hungarian algorithm should calcualate identity assignments across frames and give the same identities the same color. Please refer to Prompt 8 in this file.


## 
# Prompt 12

- First, I want to mention UI. When there is yellow highlight around the currently selected video, please add highlight either around the video frame itself if the entire frame is visible. If any side of the video frame is not visible because of zoom, then add highlight to the window the video is in. This applies to the red highlight when selecting epipolar geometry
- Please move the toast widget up to the same bar that includes `File`, `Edit`, `View`, and `Load Demo` buttons
- When epipolar geometry runs, identity assignments across views should match color, i.e. you should be changing the color of the skeleton.
- Once identities across views are grouped, they should all have a label with the associated track name mentioned in the `instance` tab

##

# Prompt 13

- When a video is zoomed in, there no highlights on the clipped side. Please add the highlight
- Disable zooming out if the entire video can currently fit in the current window (i.e. it's fine if one direction of the video doesn't completely fit, but at least the width/height should be maxed out). There are no limits for zooming in though.
- For epipolar matching color, please use visible, pleasant colors. Start with the primary colors: red, blue, green, orange, etc.., then consider adding more various shades colors as then number of separate entities increase. Include your color palette plan in PROJECT.md

##

# Prompt 14

I am currently using the directory `/root/vast/joshua/slap/claude-sleap-files` to load in an session. Please use this as well to determine if the website is working properly.

- The highlight or zoom function is not working properly. The highlight is not visible for clipped sides of the video. The videos can also zoom out way past the size of the window

- After running automatic identity assignment, the color of the skeletons do not change. Please ensure that the colors are updated. Also, there are 2 mice in the views that I choose, but only one mouse (track) is defined. For automatic assignment, the number of tracks should be the minimum number of tracks out of all the selected views the user selected.


##
# Prompt 15

- The highlight or zoom function is still not working properly. The highlight is not visible for clipped sides of the video. The videos can also zoom out way past the size of the window. Please make a tester and reieratively solve this.

- The coloring scheme is showing green, which is good, but `instance_0` is blue instead of red as mentioned in color pallete mentioned in PROJECT.md. When the user either clicks on a track or on the track label in the `instance` tab, all the other corresponding tracks in different views should have their skeleton change to a slightly brigher color

- When the user clicks on triangulation, run it only using the views they have used to make group assignments. i.e. either the views they used for epipolar geometry or for manual assignment.


## 
# Prompt 16

- I can see the highlight around the border now. The zoom feature is too restrictive; currently it forces the video to fit the window size when any side is about to zoom out of frame.
- The video should stop zooming out when **both** sides of the video are starting to become smaller than the frame they are in. So for a rectangular video in a square viewing window, it's okay if the height or width does not entirely fit the window, as long as one of them are still within the boundaries.
- Ask me questions for clarification if needed

- Another UI is that the the toast is in the correct bar, but is it displayed on the right hand side of the screen. Please put it in the center of the bar and wrap it around a rectangular highlight. Choose a highlight color you think fill fit the website asethetic

##
# Prompt 17

1. Commit the current state of the project. Please write include the following capabilites

    - Automatic identity assignment with user selected windows
    - Triangulation using user selected windows
    - Highlight around windows
    - Skeleton not changed


2. Move on to these following instructions once you're finished with the commit.

- The skeleton should be already defined by the SLP files, so in the info->skeleton tab, please remove user capability to edit the nodes. The user should still be able to edit the edges, so unchange the edges. Move the edges portion above the nodes section
- If the user loads a skeleton file (should be formatted as a `json`) into the info->skeleton tab, or one is provided in the sessions folder (it should include the word `skeleton` in the name with the `json` extension), then override the current skeleton or the one in the SLP files with the user provided one.

##
# Prompt 18

**Goal:** Enable automatic identity assignment across a user-defined range of frames.

**Flyout Menu:**
Add a flyout menu to the right of `Assign -> Automatic` with two options: `Current Frame` and `Multiple Frames`. `Current Frame` retains the existing automatic identity assignment behavior.

`Multiple Frames` Modal:
Clicking `Multiple Frames` opens a non-dismissable modal. The modal has two states:

State 1 — Identity assignment not yet run on current frame:

* Display the message: "Run identity assignment on the current frame before running on multiple frames."
* Show a `Continue` button that dismisses the modal.

State 2 — Identity assignment already run on current frame:

* Title: "Choose Frames for Identity Assignment"
* Range slider: A dual-handle slider for selecting start and end frame indices. Min/max values correspond to the video's frame range. Handles initialize at the extremes. The start handle must never exceed or overlap the end handle.
* Text fields: Two editable text fields displaying the current start and end values, synced bidirectionally with the slider handles. Reject invalid input (non-positive, non-integer, or start > end).
* `Cancel`: Dismisses the modal and cancels the operation.
* `Continue`: Runs identity assignment on the selected frame range using the views currently selected for the current frame. Display a real-time progress bar showing the fraction of completed frames.


##
# Prompt 19

**Bug Fix**: Identity assignment is currently running automatically when a session folder is loaded. Remove this behavior — identity assignment should only run when explicitly triggered by the user through the `Assign` menu