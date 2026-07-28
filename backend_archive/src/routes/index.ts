import { Router } from "express";
import healthRouter from "./health.route";
import { API_PREFIX } from "../constants";

const router = Router();

router.use(API_PREFIX, healthRouter);

export default router;
