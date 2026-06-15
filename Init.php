<?php
/**
 * This file is part of FSOffline plugin for FacturaScripts.
 * FacturaScripts Copyright (C) 2015-2026 Carlos Garcia Gomez <carlos@facturascripts.com>
 * FSOffline      Copyright (C) 2026-2026 Jose Antonio Cuello Principal <yopli2000@gmail.com>
 *
 * This program and its files are under the terms of the license specified in the LICENSE file.
 */

namespace FacturaScripts\Plugins\FSOffline;

use FacturaScripts\Core\Template\InitClass;

/**
 * FSOffline plugin initialization.
 *
 * This plugin is mainly a JavaScript library: its deliverable is the
 * Assets/JS/FSOffline.js entry file (plus the ES modules under
 * Assets/JS/FSOffline/), which FacturaScripts merges into Dinamic/Assets/JS/ so
 * any other plugin can load it.
 *
 * The only server-side piece is the AppPing controller, a bare reachability
 * endpoint (/AppPing) used by FSOffline.Connection. It does not need to be
 * registered here: the Kernel auto-registers every Dinamic/Controller file as a
 * route named after the class.
 *
 * @author Jose Antonio Cuello Principal <yopli2000@gmail.com>
 */
final class Init extends InitClass
{
    public function init(): void
    {
    }

    public function uninstall(): void
    {
    }

    public function update(): void
    {
    }
}
