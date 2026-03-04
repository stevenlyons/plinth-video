# Feature PRD: Track playback position

## Overview

In addition to monitoring the video quality of experience, the same data, namely the last playhead position is useful for the video service. Storing that value allows the viewer to exit the video playback and come back to the same time in the video. It also allows the service to determine if a video is watched enough to be marked as "complete". 

Many services will run multiple client beacons, one to monitor quality of experience and playback quality, one for tracking engagement, and another for playback position. This causes the client to experience more stress on the playback and more network traffic, both of which can impact playback quality. 

## Goals
* Allow implementors of plinth-video to track the playhead value of where users ended watching a video so they can restart a new viewing session where the viewer left off.
* Reduce the amount of data trackers that need to be run on the client by proving data for playback monitoring and playback position. 

## Implementation
* The client will report the playhead position during playback
* The server, in the future when it is built, will provide an API for retreiving the playback position.
* The client will track the playhead position (as it already needs to do for sending beacons) and there will be a local, callable API that the developers can use to the get the latest position client-side.