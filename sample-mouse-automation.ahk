; ================================================
; Finance Seer - Mouse Automation Script
; ================================================
; 
; This script demonstrates basic mouse automation:
; 1. Move mouse to specific coordinates
; 2. Click on an element
; 3. Type text into a text box
; 4. Click a button
; 5. Exit
;
; Customize the coordinates below to match your screen
; ================================================

#Persistent
#SingleInstance Force
SetWorkingDir %A_ScriptDir%

; ================================================
; CUSTOMIZE THESE VALUES
; ================================================

; Mouse coordinates (X, Y positions)
; You can adjust these values to match your screen
MouseMoveX := 800
MouseMoveY := 500
TextBoxX := 850
TextBoxY := 600
ButtonX := 900
ButtonY := 700

; Text to type in the text box
InputText := "Hello, AutoHotkey!"

; Delay settings (in milliseconds)
MoveDelay := 500
TypeDelay := 100
ClickDelay := 200

; ================================================
; MAIN SCRIPT
; ================================================

; Wait a moment before starting (optional)
Sleep, 1000

; Step 1: Move mouse to target location
MouseMove, %MouseMoveX%, %MouseMoveY%, %MoveDelay%

; Step 2: Left click on the element
Click, Left, 1, 1, %ClickDelay%

; Step 3: Move to text box location
MouseMove, %TextBoxX%, %TextBoxY%, %MoveDelay%

; Step 4: Click on text box to focus it
Click, Left, 1, 1, %ClickDelay%

; Step 5: Type the input text with delay
SendInput, %InputText%

; Step 6: Add a small delay after typing
Sleep, TypeDelay

; Step 7: Move to button location
MouseMove, %ButtonX%, %ButtonY%, %MoveDelay%

; Step 8: Click the button
Click, Left, 1, 1, %ClickDelay%

; Step 9: Optional - Show completion message
ToolTip, Automation Complete!
Sleep, 2000
ToolTip

; Step 10: Exit the script
ExitApp

; ================================================
; USEFUL MODIFICATIONS
; ================================================

; For right-click:
; Click, Right

; For double-click:
; Click, DblClick

; For different click speeds:
; Click, 0, 0, 0, 0, 0, 1  ; Default speed
; Click, 0, 0, 0, 0, 0, 0.5 ; Half speed
; Click, 0, 0, 0, 0, 0, 2   ; Double speed

; For absolute mouse coordinates (instead of relative):
; CoordMode, Mouse, Screen

; For window-relative coordinates:
; CoordMode, Mouse, Window

; To click within a specific window:
; WinActivate, Window Title
; Click

; To type without delay (fast):
; SendInput, %InputText%

; To type with individual character delay:
; Loop, Parse, InputText
;     Send, %A_LoopField%
;     Sleep, 50

; To select a range before typing:
; Click, %TextBoxX%, %TextBoxY%
; Send, ^a  ; Select all
; Sleep, 100
; Send, %InputText%

; To copy text to clipboard:
; ClipCursor := Clipboard
; Send, %InputText%
; Clipboard := ClipCursor