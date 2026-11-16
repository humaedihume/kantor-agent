@echo off
rem Jalankan Kantor Agent di Windows untuk folder project saat ini (atau folder yang diberikan).
rem Pemakaian:  kantor-start.cmd            (project = folder saat ini)
rem             kantor-start.cmd "C:\path\project"
if not "%~1"=="" (set "KANTOR_PROJECT=%~1") else (set "KANTOR_PROJECT=%CD%")
start "" http://127.0.0.1:8788/kerja
node "%~dp0skills\kantor-agent\runtime\bin\serve-node.mjs"
