

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