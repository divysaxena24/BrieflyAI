"use client";

import React from "react";
import { motion } from "framer-motion";

interface StatsGridProps {
  children: React.ReactNode;
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.06,
    },
  },
};

export const StatsGrid: React.FC<StatsGridProps> = ({ children }) => {
  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="mb-8 grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6"
    >
      {children}
    </motion.div>
  );
};
