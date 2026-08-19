# Loosely Covered - Set Lists

## Overview

Loosely Covered is a band that plays songs from an extensive "master" song list.  We use Set Lists, managed in [Google Sheets](https://docs.google.com/spreadsheets/d/1taBIDL661FEPgLM9siWrYPdy0aWgPgDwZXIBXYNmgXM/edit?usp=sharing), to define the specific songs from that master song list that we choose to play at a specific gig.  We use Lead Sheets, managed in [GitHub](https://github.com/loosely-covered/set-lists), to provide lyrics, keys, etc for each song in the overall song list.  We also use GitHub Actions in this repo to automate the creation of PDF files for each Set List.

## Create or Update a Set List

We use [this Google Sheets spreadsheet](https://docs.google.com/spreadsheets/d/1taBIDL661FEPgLM9siWrYPdy0aWgPgDwZXIBXYNmgXM/edit?usp=sharing) to manage the Set Lists for our gigs.  Within that spreadsheet, we store all of our gigs using the "YYYY-MM-DD-Location" naming convention (e.g., 2021-01-08-Murphys).  Please do NOT edit any of the locked sheets.

To create a new Set List, take the following steps.

1. Open [the Google Sheets spreadsheet](https://docs.google.com/spreadsheets/d/1taBIDL661FEPgLM9siWrYPdy0aWgPgDwZXIBXYNmgXM/edit?usp=sharing).
2. Duplicate the `YYYY-MM-DD-Location` sheet.
3. Rename the duplicated sheet as appropriate (e.g., 2021-01-08-Hopmonk).
4. Add your chosen songs in the Songs column; the drop-down only allows you to choose from song names from the song list in the Lookup sheet. 
5. Add the associated singer for each song in the Singer column; the drop-down only allows you to choose from singers from the singers list in the Lookup sheet.
6. Save the new set list, which triggers **????**.
7. Navigate to [this GitHub repo](https://github.com/loosely-covered/set-lists), and download the newly-created PDF for your new Set List.

Each Set List, with its included Lead Sheets, is produced as a specially-formatted PDF file.  You can print the PDF file to paper, or view the PDF file on a tablet.  The formatting allows for easy readability in bad lighting.

To update a Set List, take the following similar steps.

1. Open [the Google Sheets spreadsheet](https://docs.google.com/spreadsheets/d/1taBIDL661FEPgLM9siWrYPdy0aWgPgDwZXIBXYNmgXM/edit?usp=sharing).
2. Edit the appropriate Set List sheet (e.g., 2021-01-08-Hopmonk).
3. Edit the songs and singers, as needed.
4. Save the updated set list, which triggers **????**.
5. Navigate to [this GitHub repo](https://github.com/loosely-covered/set-lists), and download the newly-updated PDF for your new Set List.


## Create or Update a Lead Sheet 

Within each Set List, we also include the associated Lead Sheets for each song in the Set List.  Each Lead Sheet includes (ideally) the name of each song, the key of each song, the lyrics for each song, and assorted notes about how we play that song.

The `lead-sheet` folder in this GitHub repo contains all of the Lead Sheets (lyrics, plus structure, key, etc.) for the songs in our master song list.  If new songs need to be added, before creating the new Set List, go to the `lead-sheet` folder, and follow the instructions below to add the new song(s).  **Don't forget** to leave a blank line at the end of every lead sheet!

### Create a New Lead Sheet  

For a new Lead Sheet, you should create a **new file** specific to that song using the following instructions:

1. Open a browser tab to your favorite lyrics site (e.g., azlyrics.com, songlyrics.com); search for the lyrics to the new song; and copy the song lyrics.
2. In a separate browser tab, open this `set-lists` repo and click on the `lead-sheet` folder.
3. In the GitHub browser tab, click the "Add file" dropdown button, followed by the "Create new file" button.
4. In the "Name Your File ..." field, name the new Lead Sheet for that song as "Song-Name.md" (e.g., "Back-In-Black.md").  Each word should start with a capital letter, and replace all special characters (e.g. "-", "'", "&") with a dash.
5. At a minimum, on the first line of the "Edit new file" section, type the pound sign, a space, the Song Name, then a new line.
6. Then, paste the lyrics into the "Edit new file" section, and add song structure, if desired.
7. **Don't forget** to leave two spaces at the end of each line, and a blank line at the end of every lead sheet.
8. Click the green "Commit new file" button at the bottom of the page to save.
9. The new lead sheet now will appear in the `lead-sheet` folder of the repo.

### Editing and Improving Lead Sheets (optional)

All lead sheets are basically plain text.  The only requirements are having:

- the "#" symbol, followed by a space and the Song Name, on the first line;
- then a blank line;
- then the lyrics;
- then a blank line at the end.

However, a Lead Sheet is more useful with a little structure.  Take a look at the top of the Lead Sheet for [Rebel Yell](./Rebel-Yell.md).

```markdown
# Rebel Yell

https://www.youtube.com/watch?v=m0JImKXjtaA  

### Intro  _B-D-C_

### Verse  16x  _B-G-A_
Last night a little dancer
came dancing to my door
Last night a little angel
came pumping on the floor

She said, come on baby
You got a license for love
And if it expires
pray help from above, because
```

The following structure has been added to the plain-text lyrics:

- Shorten long song names like so: `# All These Things That Ive Done {short="All These Things"}`.
- Bonus points!  Add a web link to a SoundCloud track where we perform the song, or a YouTube video that has a similar version of the song.
- Section headings, like "Intro" and "Verse", have been added using the "### " symbols.  These break the song up into its major parts.
- You  can add the number of bars in each section (e.g., "16x").
- You can add blank lines to separate the different parts of each section.
- You also can add the chords for that section in italics; just put an underscore on either side of the chord progression.
- You can separate out the harmony lyrics by putting them in parentheses.

To add this kind of structure to a Lead Sheet, do the following:

1. Click on the name of the Lead Sheet in the `lead-sheet` folder of the repo.
2. Find the "pencil" icon ("Edit this file") on the right side of the page above the lyrics.
3. Make the desired changes to the structure of the song.
4. Click the green "Commit changes" button at the bottom of the page to save.
5. The edited lead sheet now will appear in the `lead-sheet` folder of the repo.


## How Each Set List Gets Built

Within the Google Sheet, there are three locked sheets:

- `GH Files`:  imports the Master-Set-List.csv file from this GH repo;
- `Lookup`:  converts that csv file into the song names of our "master" song list; and
- `YYYY-MM-DD-Location`:  a template for creating new Set Lists.

The `GH Files` sheet contains our overall master list of songs.  It's locked because it DOES NOT and SHOULD NOT be edited by hand.  Whenever a change is made **???** to this repo, we AUTOMATICALLY regenerate the [`Master-Set-List.csv`](https://github.com/loosely-covered/set-lists/blob/master/Master-Set-List.csv) in this repo.  The `GH Files` sheet simply imports this CSV file anytime there is a change.

The `Lookup` sheet is the definitive source ("lookup tables") of songs and singers from which each Set List is populated.  The list of songs is just a cleaned-up version of the `GH Files` list.  The list of singers is just a list of our current singers.  Eventually, we can add lookup tables for performers, song keys, etc.

Within this GitHub repo, we use the command-line tool [`pandoc`](https://pandoc.org) to combine all of the lead sheets for the gig, and output a PDF-based Set List for the gig.  Each `.txt` file defines the Set List.  The `_defaults.yml` and `_header.sty` files define the `pandoc` options used across all Set Lists.

Once you trigger **???**, this repo uses GitHub Actions to produce the PDF file behind the scenes using `pandoc`.  In effect, GitHub Actions runs the following command:

`pandoc -d _defaults.yml -M title='Murphys 2021-01-08' $(cat 2021-01-08-Murphys.txt) -o 2021-01-08-Murphys.pdf`

for each Set List.  **Please be patient**; it may take a few minutes for the Set List PDF to get generated.

The Master Set List automatically gets updated each time there's a change by running the following command:

`pandoc -d _defaults.yml -M title="Master Set List $(date +%F)" ./lead-sheet/*.md  -o "Master-Set-List.pdf"`

All Lead Sheets content is written in Markdown for ease-of-use.


## Notes for Kyle

TODO automatically build new/changed Set Lists  

TODO figure out a way to automate the lyrics "copy and paste"  

If using VSCode locally, run `lyrics-finder "Sublime" "What I Got" | awk '{print $0 "  ";next}1' > ./lead-sheet/What-I-Got.md`  

`wget -qO - "https://docs.google.com/spreadsheets/d/1taBIDL661FEPgLM9siWrYPdy0aWgPgDwZXIBXYNmgXM/export?format=csv&gid=571432328" | awk '{if (NR!=1) {print}}'| cut -d, -f1 | awk '{print "./lead-sheet/"$0}' | awk '{print $0 ".md";next}1' > "2021-01-08-Murphys.txt"`  
