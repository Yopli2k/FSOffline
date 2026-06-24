<?php
/**
 * This file is part of FSOffline plugin for FacturaScripts.
 * FacturaScripts Copyright (C) 2015-2026 Carlos Garcia Gomez <carlos@facturascripts.com>
 * FSOffline      Copyright (C) 2026-2026 Jose Antonio Cuello Principal <yopli2000@gmail.com>
 *
 * This program and its files are under the terms of the license specified in the LICENSE file.
 */

namespace FacturaScripts\Plugins\FSOffline\Controller;

use FacturaScripts\Core\Contract\ControllerInterface;
use FacturaScripts\Core\Response;
use FacturaScripts\Core\Tools;

/**
 * Serves the Media service worker (FSOffline.Media) with the headers a service
 * worker needs, which a plain static asset cannot provide.
 *
 * A service worker only controls the pages inside its scope, and the default
 * scope is the folder it is served from. The worker file lives under
 * Assets/JS/FSOffline/, whose URL would scope it to that subfolder and it would
 * never control the ERP pages. Serving it through this controller lets us send
 * the "Service-Worker-Allowed" header so it can be registered at the install
 * root scope regardless of where the file physically sits.
 *
 * Like AppPing, it implements ControllerInterface directly (no session, no
 * templates, no menu entry: getPageData = []) and the Kernel auto-registers it
 * as the route /MediaCache. It is unrelated to the Core Worker system
 * (Core/Worker/*, the event queue): this is a plain controller, not a WorkerClass.
 *
 * Notes:
 * - The class is NOT final: the Dinamic system generates a subclass that extends
 *   it, so marking it final would be a fatal error.
 * - It reads the worker file from the plugin's own Assets folder (not Dinamic),
 *   so it is self-contained and independent of the deploy timing.
 *
 * @author Jose Antonio Cuello Principal <yopli2000@gmail.com>
 */
class MediaCache implements ControllerInterface
{
    public function __construct(string $className, string $url = '')
    {
    }

    public function getPageData(): array
    {
        return [];
    }

    public function run(): void
    {
        $file = __DIR__ . '/../Assets/JS/FSOffline/media-worker.js';
        $script = is_file($file) ? file_get_contents($file) : '';

        (new Response($script === '' ? 404 : 200))
            ->header('Content-Type', 'application/javascript; charset=UTF-8')
            ->header('Service-Worker-Allowed', $this->scope())
            ->header('Cache-Control', 'no-cache')
            ->setContent($script)
            ->send();
    }

    /**
     * Returns the install root path used as the worker scope. For an install at
     * the domain root it is "/"; for a subdirectory install it is "/subdir/".
     */
    private function scope(): string
    {
        $route = rtrim((string)Tools::config('route', ''), '/');
        return $route === '' ? '/' : $route . '/';
    }
}
