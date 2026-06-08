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
 * This plugin is a JavaScript library. It does not register PHP models,
 * controllers or extensions. Its only deliverable is the file
 * Assets/JS/FSOffline.js, which is merged by FacturaScripts into
 * Dinamic/Assets/JS/FSOffline.js and can be loaded by any other plugin.
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
